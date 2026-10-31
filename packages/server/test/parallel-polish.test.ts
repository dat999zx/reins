// M9 T6 and T9: Clean and Start drop the sessions that can do nothing, and GET /api/parallel says when a run has ended.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../src/store.js';
import { until } from './helpers.js';
import { askedQuestion, boot, cleanup, openStream, tmpDir, type World } from './http-helpers.js';
import { loopTmp } from './loop-harness.js';

vi.setConfig({ testTimeout: 90_000 });

const TURNS = { fixture: 'claude-2.1.281-turns.jsonl', turn: 0, text: 'REINS: done' };
const FRONT = '---\nreins: 1\nname: t\nbudget: { turns: 30, minutes: 30 }\nalways: []\n---\n\n';
const PLAY = `${FRONT}## phase go\n> do it\n`;

const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const bases: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
  for (const d of bases.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* scratch */ }
  }
});

/** A scratch repo with two playbooks, all tracked. */
function repoWith() {
  const base = loopTmp('par-polish-');
  bases.push(base);
  const repo = path.join(base, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['core.autocrlf', 'false']]) g(repo, 'config', k!, v!);
  fs.writeFileSync(path.join(repo, 'a.reins.md'), PLAY);
  fs.writeFileSync(path.join(repo, 'b.reins.md'), PLAY);
  g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', 'init');
  return { base, repo };
}
type R = ReturnType<typeof repoWith>;

const spec = () => ({ title: 'T', tasks: [{ name: 'Task A', playbook: 'a.reins.md' }, { name: 'Task B', playbook: 'b.reins.md' }] });
const row = (w: World, id: string) => w.store.listParallel().find((r) => r.id === id)!;
const phaseIs = (w: World, id: string, ...p: string[]) => () => p.includes(row(w, id)?.phase ?? '');
const turns = () => [TURNS, TURNS];

async function started(w: World, R: R) {
  const r = await w.api('POST', '/api/parallel/start', { body: { cwd: R.repo, spec: spec() } });
  expect(r.status).toBe(200);
  const id = r.json.id as string;
  await until(phaseIs(w, id, 'running', 'failed'), 60_000);
  return id;
}
async function finish(w: World, sessionId: string) {
  await w.answer(sessionId, (await askedQuestion(w.store, sessionId, 'trust', 30_000)).id, 'y');
  await until(() => w.rows(sessionId, 'run_finished').length > 0, 30_000);
  await until(() => (w.store.readLog(sessionId).at(-1)?.data as { status?: string } | undefined)?.status === 'idle', 30_000);
}
async function finishAll(w: World, id: string) {
  for (const t of row(w, id).tasks) await finish(w, t.sessionId);
}
const touch = (w: World, id: string, i: number, name = `out-${i}.txt`) => fs.writeFileSync(path.join(row(w, id).job!.tasks[i]!.dir, name), 'x');
const merge = (w: World, id: string) => w.api('POST', `/api/parallel/${id}/merge`, { body: {} });
const clean = (w: World, id: string) => w.api('POST', `/api/parallel/${id}/clean`, { body: {} });
const stateIds = async (w: World) => ((await w.api('GET', '/api/state')).json.sessions as Array<{ id: string }>).map((s) => s.id);
const ended = async (w: World, id: string) => ((await w.api('GET', '/api/parallel')).json.runs as Array<{ id: string; ended: boolean }>).find((r) => r.id === id)!.ended;

describe('Clean forgets the sessions of a removed worktree (T6)', () => {
  it('a clean run leaves no task session in the state, and the log stays in the database', async () => {
    const w = await boot(turns());
    const R = repoWith();
    const id = await started(w, R);
    const ids = row(w, id).tasks.map((t) => t.sessionId);
    await finishAll(w, id);
    touch(w, id, 0); touch(w, id, 1);
    expect((await merge(w, id)).status).toBe(200);
    await until(phaseIs(w, id, 'done', 'failed'), 60_000);
    expect(row(w, id).phase).toBe('done');
    expect((await clean(w, id)).json.forgotten).toBe(true);
    const now = await stateIds(w);
    for (const s of ids) {
      expect(now).not.toContain(s);
      expect((await w.api('GET', `/api/sessions/${s}/log`)).status).toBe(404);
      expect(w.store.readLog(s).length).toBeGreaterThan(0);
    }
  });

  it('a worktree Clean keeps still shows', async () => {
    const w = await boot(turns());
    const R = repoWith();
    const id = await started(w, R);
    const [a, b] = row(w, id).tasks.map((t) => t.sessionId) as [string, string];
    await finishAll(w, id);
    touch(w, id, 0);
    expect((await merge(w, id)).status).toBe(200);
    await until(phaseIs(w, id, 'done', 'failed'), 60_000);
    const dirB = row(w, id).job!.tasks[1]!.dir;
    fs.writeFileSync(path.join(dirB, 'late.txt'), 'x');
    g(dirB, 'add', '-A'); g(dirB, 'commit', '-qm', 'x');
    const c = await clean(w, id);
    expect(c.json.removed).toEqual(['Task A']);
    expect(c.json.kept.map((k: { name: string }) => k.name)).toEqual(['Task B']);
    expect(c.json.forgotten).toBe(true);
    const now = await stateIds(w);
    expect(now).toContain(b);
    expect(now).not.toContain(a);
  });

  it('an unfinished clean keeps every session', async () => {
    const w = await boot(turns());
    const R = repoWith();
    const id = await started(w, R);
    const ids = row(w, id).tasks.map((t) => t.sessionId);
    await finishAll(w, id);
    touch(w, id, 0); touch(w, id, 1);
    expect((await merge(w, id)).status).toBe(200);
    await until(phaseIs(w, id, 'done', 'failed'), 60_000);
    fs.writeFileSync(path.join(row(w, id).job!.tasks[0]!.dir, 'dirty.txt'), 'x');
    const c = await clean(w, id);
    expect(c.json.forgotten).toBe(false);
    expect(row(w, id)).toBeDefined();
    const now = await stateIds(w);
    for (const s of ids) expect(now).toContain(s);
  });
});

describe('Start drops what can do nothing (T6)', () => {
  const mk = (store: ReturnType<typeof openStore>, id: string, cwd: string, closed: boolean) => {
    store.createSession({ id, cwd, engine: 'claude-code' });
    if (closed) store.appendLog(id, { type: 'status', data: { status: 'closed' } });
  };

  it('only a closed or idle session with a gone folder that no run lists is dropped', async () => {
    const dir = tmpDir();
    const file = path.join(tmpDir(), 'reins.db');
    const store = openStore(file);
    const gone = path.join(tmpDir(), 'gone');
    const there = tmpDir();
    mk(store, 'closedgone', gone, true);
    mk(store, 'idlegone', gone, false);
    mk(store, 'closedhere', there, true);
    mk(store, 'closedlisted', gone, true);
    mk(store, 'idlelisted', gone, false);
    store.createParallel({ id: 'aaaaaaaaaaaa', title: 'r', tasks: [{ name: 'a', sessionId: 'closedlisted' }, { name: 'b', sessionId: 'idlelisted' }] });
    const w = await boot([], { store, dir });
    const now = await stateIds(w);
    expect(now.sort()).toEqual(['closedhere', 'closedlisted', 'idlelisted']);
    const s = openStream(w.srv);
    await s.ready;
    await until(() => s.rows.some((r) => r.sessionId === 'closedhere'), 10_000);
    const seen = new Set(s.rows.map((r) => r.sessionId));
    expect(seen.has('closedgone')).toBe(false);
    expect(seen.has('idlegone')).toBe(false);
    expect(w.store.readLog('closedgone').length).toBeGreaterThan(0);
  });

  it('a folder that cannot be read is not a gone folder', async () => {
    const dir = tmpDir();
    const file = path.join(tmpDir(), 'reins.db');
    const store = openStore(file);
    const here = tmpDir();
    store.createSession({ id: 'locked', cwd: here, engine: 'claude-code' });
    store.appendLog('locked', { type: 'status', data: { status: 'closed' } });
    const real = fs.statSync;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === here) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return (real as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.statSync);
    const w = await boot([], { store, dir });
    spy.mockRestore();
    expect(await stateIds(w)).toContain('locked');
  });
});

describe('GET /api/parallel says when a run has ended (T9)', () => {
  it('false while a task runs, true when every task has ended', async () => {
    const w = await boot(turns());
    const R = repoWith();
    const id = await started(w, R);
    expect(await ended(w, id)).toBe(false);
    await finishAll(w, id);
    expect(await ended(w, id)).toBe(true);
  });

  it('true for a task that never ran, and Merge calls it never ran', async () => {
    const w = await boot(turns());
    const R = repoWith();
    const id = await started(w, R);
    const [a, b] = row(w, id).tasks.map((t) => t.sessionId) as [string, string];
    await w.answer(a, (await askedQuestion(w.store, a, 'trust', 30_000)).id, 'n');
    await until(() => (w.store.readLog(a).at(-1)?.data as { status?: string } | undefined)?.status === 'idle', 30_000);
    await finish(w, b);
    expect(await ended(w, id)).toBe(true);
    touch(w, id, 1);
    expect((await merge(w, id)).status).toBe(200);
    await until(phaseIs(w, id, 'done', 'failed'), 60_000);
    expect(row(w, id).job!.notMerged).toEqual([{ name: 'Task A', why: 'never ran' }]);
  });

  it('true for a created row whose session is idle', async () => {
    const w = await boot();
    const base = tmpDir();
    const repo = path.join(base, 'repo'), d = path.join(base, 'a');
    fs.mkdirSync(repo); fs.mkdirSync(d);
    const r = await w.api('POST', '/api/parallel', { body: { title: 'Run', repo, tasks: [{ name: 'a', dir: d }] } });
    expect(r.status).toBe(200);
    expect(await ended(w, r.json.id as string)).toBe(true);
  });
});
