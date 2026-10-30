// M8 S3: the start, preview, merge and clean routes over real HTTP, with the job running on the server.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Redactor } from '../src/secrets.js';
import { KEY_IN_IDENTITY, openStore } from '../src/store.js';
import { until } from './helpers.js';
import { askedQuestion, boot, cleanup, tmpDir, type World } from './http-helpers.js';
import { loopTmp } from './loop-harness.js';

vi.setConfig({ testTimeout: 90_000 });

const TURNS = { fixture: 'claude-2.1.281-turns.jsonl', turn: 0, text: 'REINS: done' };
const FRONT = '---\nreins: 1\nname: t\nbudget: { turns: 30, minutes: 30 }\nalways: []\n---\n\n';
const PLAY = `${FRONT}## phase go\n> do it\n`;
const NODE = `"${process.execPath}"`;
const BUSY = 'A job is already running in this repo.';
const KEY = 'sk-test-abcdefghijklmnop1234';

const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const bases: string[] = [];
afterEach(async () => {
  await cleanup();
  for (const d of bases.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* scratch */ }
  }
});

/** A scratch repo with two playbooks and small gate scripts, all tracked. */
function repoWith() {
  const base = loopTmp('par-start-');
  bases.push(base);
  const repo = path.join(base, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['core.autocrlf', 'false']]) g(repo, 'config', k!, v!);
  fs.writeFileSync(path.join(repo, 'a.reins.md'), PLAY);
  fs.writeFileSync(path.join(repo, 'b.reins.md'), PLAY);
  fs.writeFileSync(path.join(repo, 'ok.mjs'), 'console.log("fine");');
  fs.writeFileSync(path.join(repo, 'bad.mjs'), 'console.log("boom"); process.exitCode = 1;');
  fs.writeFileSync(path.join(repo, 'sleep.mjs'), 'setInterval(() => {}, 1000);');
  fs.writeFileSync(path.join(repo, 'nomark.mjs'), 'process.exitCode = 3; console.log("install broke");');
  fs.writeFileSync(path.join(repo, 'tasks.json'), JSON.stringify({ title: 'T', tasks: [{ name: 'Task A', playbook: 'a.reins.md' }, { name: 'Task B', playbook: 'b.reins.md' }] }));
  g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', 'init');
  return { base, repo };
}
type R = ReturnType<typeof repoWith>;

const spec = (extra: Record<string, unknown> = {}) => ({ title: 'T', tasks: [{ name: 'Task A', playbook: 'a.reins.md' }, { name: 'Task B', playbook: 'b.reins.md' }], ...extra });
const start = (w: World, R: R, s: unknown = spec(), extra: Record<string, unknown> = {}) => w.api('POST', '/api/parallel/start', { body: { cwd: R.repo, spec: s, ...extra } });
const row = (w: World, id: string) => w.store.listParallel().find((r) => r.id === id)!;
const phaseIs = (w: World, id: string, ...p: string[]) => () => p.includes(row(w, id)?.phase ?? '');
const turns = () => [TURNS, TURNS];

/** Starts a run and waits until every session has its playbook (phase `running`). */
async function started(w: World, R: R, s: unknown = spec()) {
  const r = await start(w, R, s);
  expect(r.status).toBe(200);
  const id = r.json.id as string;
  await until(phaseIs(w, id, 'running', 'failed'), 60_000);
  return id;
}
/** Answers the trust card of one task and waits for its run to end. */
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

describe('preview', () => {
  it('returns the repo and a spec with slugs', async () => {
    const w = await boot();
    const R = repoWith();
    const r = await w.api('POST', '/api/parallel/preview', { body: { cwd: path.join(R.repo), file: 'tasks.json' } });
    expect(r.status).toBe(200);
    expect(r.json.repo).toBe(R.repo);
    expect(r.json.spec.tasks.map((t: { slug: string }) => t.slug)).toEqual(['task-a', 'task-b']);
    expect(r.json.spec.copy).toEqual([]);
    const abs = await w.api('POST', '/api/parallel/preview', { body: { cwd: R.repo, file: path.join(R.repo, 'tasks.json') } });
    expect(abs.status).toBe(200);
  });

  it('refuses with the words', async () => {
    const redactor = new Redactor({ home: tmpDir(), env: { P_API_KEY: KEY }, keyEnvNames: () => ['P_API_KEY'] });
    const w = await boot([], { redactor });
    const R = repoWith();
    const outside = path.join(R.base, 'out.json');
    fs.writeFileSync(outside, '{}');
    fs.writeFileSync(path.join(R.repo, 'bad.json'), '{ nope');
    fs.writeFileSync(path.join(R.repo, 'keyed.json'), JSON.stringify({ title: KEY, tasks: [{ name: 'a', playbook: 'a.reins.md' }] }));
    const plain = tmpDir();
    const p = (cwd: unknown, file: unknown) => w.api('POST', '/api/parallel/preview', { body: { cwd, file } });
    expect((await p('rel', 'tasks.json')).json.error).toBe('cwd must be an absolute path.');
    expect((await p(plain, 'tasks.json')).json.error).toBe('This folder is not in a git repository.');
    expect((await p(R.repo, outside)).json.error).toBe('The tasks file must be inside the repo.');
    expect((await p(R.repo, '../out.json')).json.error).toBe('The tasks file must be inside the repo.');
    expect((await p(R.repo, 'missing.json')).json.error).toBe('Cannot read the tasks file.');
    expect((await p(R.repo, 'bad.json')).json.error).toBe('The tasks file is not valid JSON.');
    const keyed = await p(R.repo, 'keyed.json');
    expect(keyed.status).toBe(400);
    expect(keyed.json.error).toBe(KEY_IN_IDENTITY);
  });

  it('refuses a repo under the Reins folder', async () => {
    const R = repoWith();
    const w = await boot([], { dir: R.base });
    const r = await w.api('POST', '/api/parallel/preview', { body: { cwd: R.repo, file: 'tasks.json' } });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('A repo under the Reins folder cannot start a run.');
  });
});

describe('start refusals', () => {
  it('a dirty tree is a 409 with no row, and the key is free afterwards', async () => {
    const w = await boot(turns());
    const R = repoWith();
    fs.writeFileSync(path.join(R.repo, 'dirty.txt'), 'x');
    const r = await start(w, R);
    expect(r.status).toBe(409);
    expect(r.json.error).toContain('The working tree is not clean; commit or stash first:\n');
    expect(r.json.error).toContain('dirty.txt');
    expect(w.store.listParallel()).toEqual([]);
    fs.rmSync(path.join(R.repo, 'dirty.txt'));
    const again = await start(w, R);
    expect(again.status).toBe(200);
    await until(phaseIs(w, again.json.id, 'running', 'failed'), 60_000);
  });

  it('an unknown model is a 400 with no row and no worktree', async () => {
    const w = await boot(turns());
    const R = repoWith();
    const r = await start(w, R, spec({ tasks: [{ name: 'Task A', playbook: 'a.reins.md', model: 'no-such-model-x' }] }));
    expect(r.status).toBe(400);
    expect(w.store.listParallel()).toEqual([]);
    expect(g(R.repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('a bad spec is a 400 with no row', async () => {
    const w = await boot(turns());
    const R = repoWith();
    const r = await start(w, R, { title: 'T', tasks: [] });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('tasks must be a non-empty array.');
    expect(w.store.listParallel()).toEqual([]);
    expect((await w.api('POST', '/api/parallel/start', { body: { cwd: 'rel', spec: spec() } })).json.error).toBe('cwd must be an absolute path.');
    expect((await w.api('POST', '/api/parallel/start', { body: { cwd: tmpDir(), spec: spec() } })).json.error).toBe('This folder is not in a git repository.');
  });

  const DIR = 'dir must be an absolute folder outside the repo and the Reins folder.';
  it.each([
    ['a number', () => 5],
    ['relative', () => 'rel/folder'],
    ['a NUL', (R: R) => `${R.base}\0x`],
    ['a drive root', () => path.parse(process.cwd()).root],
    ['the repo', (R: R) => R.repo],
    ['under the repo', (R: R) => path.join(R.repo, 'sub')],
  ])('dir %s is refused with no row', async (_n, make) => {
    const w = await boot(turns());
    const R = repoWith();
    const r = await start(w, R, spec(), { dir: make(R) });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe(DIR);
    expect(w.store.listParallel()).toEqual([]);
  });

  it('dir under the Reins folder is refused, and so is a repo under it', async () => {
    const R = repoWith();
    const w = await boot(turns());
    const r = await start(w, R, spec(), { dir: path.join(w.dir, 'runs') });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe(DIR);
    expect(w.store.listParallel()).toEqual([]);
    const under = await boot(turns(), { dir: R.base });
    const u = await start(under, R);
    expect(u.status).toBe(400);
    expect(u.json.error).toBe('A repo under the Reins folder cannot start a run.');
  });

  it('a key in the spec is refused', async () => {
    const redactor = new Redactor({ home: tmpDir(), env: { P_API_KEY: KEY }, keyEnvNames: () => ['P_API_KEY'] });
    const w = await boot(turns(), { redactor });
    const R = repoWith();
    const r = await start(w, R, spec({ title: KEY }));
    expect(r.status).toBe(400);
    expect(r.json.error).toBe(KEY_IN_IDENTITY);
    expect(w.store.listParallel()).toEqual([]);
  });
});

describe('one job per repo', () => {
  it('two concurrent starts: one 200, one 409, one row', async () => {
    const w = await boot(turns());
    const R = repoWith();
    const rs = await Promise.all([start(w, R), start(w, R)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(rs.find((r) => r.status === 409)!.json.error).toBe(BUSY);
    expect(w.store.listParallel()).toHaveLength(1);
    await until(phaseIs(w, rs.find((r) => r.status === 200)!.json.id, 'running', 'failed'), 60_000);
  });

  it('two concurrent merges: one 200, one 409; merge against clean the same', async () => {
    const w = await boot(turns());
    const R = repoWith();
    const id = await started(w, R);
    await finishAll(w, id);
    touch(w, id, 0);
    const ms = await Promise.all([merge(w, id), merge(w, id)]);
    expect(ms.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(ms.find((r) => r.status === 409)!.json.error).toBe(BUSY);
    await until(phaseIs(w, id, 'done', 'failed'), 60_000);
    expect(row(w, id).phase).toBe('done');
    const mix = await Promise.all([merge(w, id), clean(w, id)]);
    expect(mix.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('a start or merge while a job runs is a 409', async () => {
    const w = await boot(turns());
    const R = repoWith();
    const r = await start(w, R, spec({ install: `${NODE} sleep.mjs` }));
    expect(r.status).toBe(200);
    expect(row(w, r.json.id).phase).toBe('setup');
    const second = await start(w, R);
    expect(second.status).toBe(409);
    expect(second.json.error).toBe(BUSY);
    expect((await merge(w, r.json.id)).json.error).toBe(BUSY);
    expect((await clean(w, r.json.id)).json.error).toBe(BUSY);
    expect(w.store.listParallel()).toHaveLength(1);
  });
});

describe('the whole run', () => {
  it('starts, runs, merges, gates and cleans', async () => {
    const w = await boot(turns());
    const R = repoWith();
    const r = await start(w, R, spec({ gate: `${NODE} ok.mjs` }));
    expect(r.status).toBe(200);
    const id = r.json.id as string;
    expect(row(w, id).phase).toBe('setup');
    expect(row(w, id).tasks).toEqual([]);
    await until(phaseIs(w, id, 'running', 'failed'), 60_000);
    const run = row(w, id);
    expect(run.phase).toBe('running');
    expect(run.job!.tasks.map((t) => fs.existsSync(t.dir))).toEqual([true, true]);
    expect(run.tasks).toHaveLength(2);
    expect(run.job!.branch).toBe('main');
    const early = await merge(w, id);
    expect(early.status).toBe(409);
    expect(early.json.error).toBe('Task Task A has not ended.');
    await finishAll(w, id);
    touch(w, id, 0);
    touch(w, id, 1);
    const m = await merge(w, id);
    expect(m.status).toBe(200);
    expect(m.json).toEqual({ phase: 'merging' });
    await until(phaseIs(w, id, 'done', 'failed'), 60_000);
    const done = row(w, id);
    expect(done.phase).toBe('done');
    expect(done.job!.merged).toEqual(['Task A', 'Task B']);
    expect(done.job!.gateResult).toBe('pass');
    expect(g(R.repo, 'log', '--format=%s')).toContain('parallel: merge Task A');
    expect(g(R.repo, 'log', '--format=%s')).toContain('parallel: merge Task B');
    expect((await merge(w, id)).json.error).toBe('This run is already merged.');
    const c = await clean(w, id);
    expect(c.status).toBe(200);
    expect(c.json.removed).toEqual(['Task A', 'Task B']);
    expect(c.json.forgotten).toBe(true);
    expect((await w.api('GET', '/api/parallel')).json.runs).toEqual([]);
    for (const t of run.job!.tasks) expect(fs.existsSync(t.dir)).toBe(false);
    expect(g(R.repo, 'branch', '--list', 'par-*')).toBe('');
  });

  it('refuses merge on a run made by POST /api/parallel, and clean while running', async () => {
    const w = await boot(turns());
    const R = repoWith();
    const dirA = path.join(R.base, 'a');
    fs.mkdirSync(dirA);
    const made = await w.api('POST', '/api/parallel', { body: { title: 'Run', repo: R.repo, tasks: [{ name: 'a', dir: dirA }] } });
    expect(made.status).toBe(200);
    const words = 'This run was not started by Reins, so it has no merge or clean.';
    expect((await merge(w, made.json.id)).json.error).toBe(words);
    expect((await clean(w, made.json.id)).json.error).toBe(words);
    expect((await merge(w, 'abcdef012345')).status).toBe(404);
    expect((await clean(w, 'abcdef012345')).json.error).toBe('No such parallel run.');
    const id = await started(w, R);
    const c = await clean(w, id);
    expect(c.status).toBe(409);
    expect(c.json.error).toBe('Clean needs a finished run. Merge first, or stop the tasks and merge.');
  });

  it('a task whose trust card was refused does not block the run', async () => {
    const w = await boot(turns());
    const R = repoWith();
    const id = await started(w, R);
    const [a, b] = row(w, id).tasks.map((t) => t.sessionId) as [string, string];
    await w.answer(a, (await askedQuestion(w.store, a, 'trust', 30_000)).id, 'n');
    await until(() => (w.store.readLog(a).at(-1)?.data as { status?: string } | undefined)?.status === 'idle', 30_000);
    await finish(w, b);
    touch(w, id, 1);
    expect((await merge(w, id)).status).toBe(200);
    await until(phaseIs(w, id, 'done', 'failed'), 60_000);
    const done = row(w, id);
    expect(done.phase).toBe('done');
    expect(done.job!.notMerged).toEqual([{ name: 'Task A', why: 'never ran' }]);
    expect(done.job!.merged).toEqual(['Task B']);
    const c = await clean(w, id);
    expect(c.status).toBe(200);
    // Task A's branch never moved off the start commit, so it counts as merged and nothing is lost by removing it.
    expect(c.json.removed).toEqual(['Task A', 'Task B']);
    expect(c.json.kept).toEqual([]);
  });

  it('a failed install fails the run; merge is refused and clean removes everything', async () => {
    const w = await boot(turns());
    const R = repoWith();
    const r = await start(w, R, spec({ install: `${NODE} nomark.mjs` }));
    const id = r.json.id as string;
    await until(phaseIs(w, id, 'failed'), 60_000);
    expect(row(w, id).job!.words).toContain('task Task A');
    expect(row(w, id).job!.words).toContain('install broke');
    const m = await merge(w, id);
    expect(m.status).toBe(409);
    expect(m.json.error).toBe('Setup did not finish. Clean it and start again.');
    const c = await clean(w, id);
    expect(c.status).toBe(200);
    expect(c.json.forgotten).toBe(true);
    expect(g(R.repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(g(R.repo, 'branch', '--list', 'par-*')).toBe('');
  });

  it('a done run whose clean throws stays done', async () => {
    const w = await boot(turns());
    const R = repoWith();
    const id = await started(w, R);
    await finishAll(w, id);
    expect((await merge(w, id)).status).toBe(200);
    await until(phaseIs(w, id, 'done', 'failed'), 60_000);
    expect(row(w, id).phase).toBe('done');
    w.store.patchParallel(id, { job: { repo: path.join(R.base, 'missing-repo') } });
    const c = await clean(w, id);
    expect(c.status).toBeGreaterThanOrEqual(500);
    expect(row(w, id).phase).toBe('done');
    // the key was released: a second clean answers, it is not busy
    expect((await clean(w, id)).json.error).not.toBe(BUSY);
  });

  it('resume all on a setup row is an empty 200', async () => {
    const w = await boot(turns());
    const R = repoWith();
    const r = await start(w, R, spec({ install: `${NODE} sleep.mjs` }));
    expect(row(w, r.json.id).phase).toBe('setup');
    const res = await w.api('POST', `/api/parallel/${r.json.id}/resume`, { body: {} });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ results: [] });
  });
});

describe('restart', () => {
  it('a gate that was running reads interrupted, and merge and clean go on', async () => {
    const dir = tmpDir();
    const file = path.join(tmpDir(), 'reins.db');
    const R = repoWith();
    const w1 = await boot(turns(), { store: openStore(file), dir });
    const id = await started(w1, R, spec({ gate: `${NODE} sleep.mjs` }));
    await finishAll(w1, id);
    touch(w1, id, 0);
    expect((await merge(w1, id)).status).toBe(200);
    await until(phaseIs(w1, id, 'gating', 'failed'), 60_000);
    expect(row(w1, id).phase).toBe('gating');
    const t0 = Date.now();
    await w1.srv.close();
    expect(Date.now() - t0).toBeLessThan(15_000);
    w1.store.close();

    const w2 = await boot([], { store: openStore(file), dir, fake: w1.fake });
    const back = row(w2, id);
    expect(back.phase).toBe('interrupted');
    expect(back.job!.words).toContain('gating');
    w2.store.patchParallel(id, { job: { gate: `${NODE} ok.mjs` } });
    expect((await merge(w2, id)).status).toBe(200);
    await until(phaseIs(w2, id, 'done', 'failed'), 60_000);
    expect(row(w2, id).phase).toBe('done');
    expect((await clean(w2, id)).status).toBe(200);
    expect((await w2.api('GET', '/api/parallel')).json.runs).toEqual([]);
  });
});
