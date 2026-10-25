import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/store.js';
import { startRunCli } from '../src/run-cli.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reins-store-'));

describe('sessions and the session log (3b.3)', () => {
  it('sessions round trip: create, get, list oldest first, update', () => {
    const s = openStore(':memory:');
    const a = s.createSession({ id: 'a', cwd: 'C:\\p', engine: 'claude', model: 'm', effort: 'high', title: 'first' });
    expect(a).toEqual({ id: 'a', cwd: 'C:\\p', engine: 'claude', model: 'm', effort: 'high', title: 'first', autoApprove: false, createdAt: expect.any(Number), updatedAt: expect.any(Number) });
    s.createSession({ id: 'b', cwd: 'C:\\q', engine: 'claude' });
    expect(s.getSession('b')).toEqual(expect.objectContaining({ id: 'b', autoApprove: false }));
    expect(s.getSession('b')).not.toHaveProperty('model');
    expect(s.getSession('zzz')).toBeUndefined();
    expect(s.listSessions().map((x) => x.id)).toEqual(['a', 'b']);
    s.updateSession('a', { autoApprove: true, title: 'renamed', engineSessionId: 'eng-1' });
    expect(s.getSession('a')).toEqual(expect.objectContaining({ autoApprove: true, title: 'renamed', engineSessionId: 'eng-1' }));
    s.updateSession('a', { autoApprove: false });
    expect(s.getSession('a')).toEqual(expect.objectContaining({ autoApprove: false, title: 'renamed', engineSessionId: 'eng-1' }));
    s.close();
  });

  it('the model can be set and cleared', () => {
    const s = openStore(':memory:');
    s.createSession({ id: 'a', cwd: '.', engine: 'claude' });
    s.updateSession('a', { model: 'x' });
    expect(s.getSession('a')!.model).toBe('x');
    s.updateSession('a', { model: null });
    expect(s.getSession('a')).not.toHaveProperty('model');
    s.close();
  });

  it('engine totals and settings round trip, and a reopened store keeps both tables', () => {
    const dir = tmp();
    const file = path.join(dir, 'x.db');
    const s = openStore(file);
    expect(s.getEngineTotal('e1')).toBeUndefined();
    s.putEngineTotal('e1', 0.5);
    s.putEngineTotal('e1', 0.75);
    expect(s.getEngineTotal('e1')).toBe(0.75);
    expect(s.getSetting('k')).toBeUndefined();
    s.putSetting('k', { a: 1 });
    expect(s.getSetting('k')).toEqual({ a: 1 });
    s.close();
    const again = openStore(file);
    expect(again.getEngineTotal('e1')).toBe(0.75);
    expect(again.getSetting('k')).toEqual({ a: 1 });
    expect(again.getEngineTotal('nope')).toBeUndefined();
    again.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('per-model totals: stored beside the total, and a total with no split clears them', () => {
    const s = openStore(':memory:');
    expect(s.getEngineModels('e1')).toBeUndefined();
    s.putEngineTotal('e1', 0.5, { a: 0.5 });
    expect(s.getEngineTotal('e1')).toBe(0.5);
    expect(s.getEngineModels('e1')).toEqual({ a: 0.5 });
    s.putEngineTotal('e1', 0.75, { a: 0.5, b: 0.25 });
    expect(s.getEngineModels('e1')).toEqual({ a: 0.5, b: 0.25 });
    s.putEngineTotal('e1', 0.75);
    expect(s.getEngineTotal('e1')).toBe(0.75);
    expect(s.getEngineModels('e1')).toBeUndefined();
    s.close();
  });

  it('a database made before by_model gains the column on open, keeps its totals, and a corrupt split reads as unknown', () => {
    const dir = tmp();
    const file = path.join(dir, 'old.db');
    const raw = new DatabaseSync(file);
    raw.exec('create table engine_costs (engine_session_id text primary key, total real not null, ts integer not null)');
    raw.prepare('insert into engine_costs values (?, ?, ?)').run('old', 0.4, 1);
    raw.close();
    const s = openStore(file);
    expect(s.getEngineTotal('old')).toBe(0.4);
    expect(s.getEngineModels('old')).toBeUndefined();
    s.putEngineTotal('old', 0.5, { a: 0.5 });
    expect(s.getEngineModels('old')).toEqual({ a: 0.5 });
    s.close();
    const cols = new DatabaseSync(file);
    expect((cols.prepare('pragma table_info(engine_costs)').all() as Array<{ name: string }>).map((c) => c.name)).toContain('by_model');
    cols.prepare("update engine_costs set by_model = '{oops' where engine_session_id = 'old'").run();
    cols.close();
    const again = openStore(file);
    expect(again.getEngineModels('old')).toBeUndefined();
    expect(again.getEngineTotal('old')).toBe(0.5);
    again.close();
    // valid JSON that is not a per-model map is unknown too
    const arr = new DatabaseSync(file);
    arr.prepare("update engine_costs set by_model = '[1,2]' where engine_session_id = 'old'").run();
    arr.close();
    const third = openStore(file);
    expect(third.getEngineModels('old')).toBeUndefined();
    third.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the log: seq counts per session from 1, data round trips, readLog(after) is exclusive', () => {
    const s = openStore(':memory:');
    s.createSession({ id: 'a', cwd: '.', engine: 'claude' });
    s.createSession({ id: 'b', cwd: '.', engine: 'claude' });
    expect(s.appendLog('a', { type: 'message', data: { role: 'user', text: 'hi' } })).toEqual({ sessionId: 'a', seq: 1, ts: expect.any(Number), type: 'message', data: { role: 'user', text: 'hi' } });
    s.appendLog('a', { type: 'run_started', runId: 'r1', data: { x: 1 } });
    s.appendLog('a', { type: 'status', data: { status: 'idle' } });
    expect(s.appendLog('b', { type: 'note' }).seq).toBe(1);
    expect(s.readLog('a').map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(s.readLog('a', 1).map((r) => r.seq)).toEqual([2, 3]);
    expect(s.readLog('a', 3)).toEqual([]);
    expect(s.readLog('a')[1]).toEqual(expect.objectContaining({ runId: 'r1', type: 'run_started', data: { x: 1 } }));
    expect(s.readLog('b')[0]!.data).toBeNull();
    s.close();
  });

  it('seq is seeded from max(seq) when the store is reopened, and the file is in WAL mode', () => {
    const dir = tmp();
    const file = path.join(dir, 'x.db');
    const s = openStore(file);
    s.createSession({ id: 'a', cwd: '.', engine: 'claude' });
    s.appendLog('a', { type: 'note' });
    s.appendLog('a', { type: 'note' });
    s.close();
    const again = openStore(file);
    expect(again.appendLog('a', { type: 'note' }).seq).toBe(3);
    again.close();
    const raw = new DatabaseSync(file);
    expect((raw.prepare('pragma journal_mode').get() as any).journal_mode).toBe('wal');
    expect((raw.prepare("select name from sqlite_master where type = 'index' and name = 'session_log_run'").get() as any)?.name).toBe('session_log_run');
    raw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('trust: a hash is per cwd and path, and a changed hash is not trusted', () => {
    const s = openStore(':memory:');
    expect(s.isTrusted('c', '.claude/', 'h1')).toBe(false);
    s.trust('c', '.claude/', 'h1');
    expect(s.isTrusted('c', '.claude/', 'h1')).toBe(true);
    expect(s.isTrusted('c', '.claude/', 'h2')).toBe(false);
    expect(s.isTrusted('other', '.claude/', 'h1')).toBe(false);
    s.trust('c', '.claude/', 'h2');
    expect(s.isTrusted('c', '.claude/', 'h1')).toBe(false);
    expect(s.isTrusted('c', '.claude/', 'h2')).toBe(true);
    s.close();
  });

  it('sessionOfRun finds the session that owns a run id', () => {
    const s = openStore(':memory:');
    s.createSession({ id: 'a', cwd: '.', engine: 'claude' });
    s.appendLog('a', { type: 'run_started', runId: 'r9' });
    expect(s.sessionOfRun('r9')).toBe('a');
    expect(s.sessionOfRun('nope')).toBeUndefined();
    s.close();
  });

  it('reins run --resume refuses a run that belongs to a chat session (3b.3)', async () => {
    const s = openStore(':memory:');
    s.createSession({ id: 'sess1', cwd: '.', engine: 'claude' });
    s.appendLog('sess1', { type: 'run_started', runId: 'r9' });
    s.createRun({ id: 'r9', workflowPath: 'x', cwd: '.' });
    const output = new PassThrough();
    output.setEncoding('utf8');
    let text = '';
    output.on('data', (d: string) => (text += d));
    const res = await startRunCli({ resumeId: 'r9', cwd: '.', input: new PassThrough(), output, store: s, makeEngine: () => { throw new Error('must not start'); } }).done;
    expect(res).toEqual({ runId: 'r9', status: 'invalid', exitCode: 1 });
    expect(text).toContain('run r9 belongs to chat session sess1; resume it from the app');
    s.close();
  });
});
