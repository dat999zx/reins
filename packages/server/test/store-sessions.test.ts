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
