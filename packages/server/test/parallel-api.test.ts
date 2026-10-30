// M5 T7: the parallel run routes over real HTTP, with fake-claude behind the real claudeEngine.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Redactor } from '../src/secrets.js';
import { KEY_IN_IDENTITY, openStore } from '../src/store.js';
import { until } from './helpers.js';
import { askedQuestion, boot, cleanup, tmpDir, type World } from './http-helpers.js';

afterEach(cleanup);

const T = 20_000;
const TURNS = { fixture: 'claude-2.1.281-turns.jsonl', turn: 0 };
const KEY = 'sk-test-abcdefghijklmnop1234';
const FRONT = '---\nreins: 1\nname: t\nbudget: { turns: 30, minutes: 30 }\nalways: []\n---\n\n';
const WITH_BLOCK = `${FRONT}## playbook rp\n\n## gate\nuntil: you approve\n\n## phase go\n> do it\n`;
const RP = '---\nreins: 1\nblock: rp\n---\n\n## run `echo one`\n';

/** `names` as folders under a fresh base, and a repo folder beside them. */
function folders(...names: string[]) {
  const base = tmpDir();
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  const dirs = names.map((n) => { const d = path.join(base, n); fs.mkdirSync(d); return d; });
  return { base, repo, dirs };
}
const make = (w: World, f: ReturnType<typeof folders>, names: string[], extra: Record<string, unknown> = {}) =>
  w.api('POST', '/api/parallel', { body: { title: 'Run', repo: f.repo, tasks: names.map((name, i) => ({ name, dir: f.dirs[i] })), ...extra } });
const sessionIds = (w: World) => w.store.listSessions().map((s) => s.id);

describe('parallel routes (M5 T7)', () => {
  it('create lists the run and titles its sessions', async () => {
    const w = await boot();
    const f = folders('a', 'b');
    const r = await make(w, f, ['a', 'b']);
    expect(r.status).toBe(200);
    expect(r.json.tasks.map((t: { name: string }) => t.name)).toEqual(['a', 'b']);
    const list = (await w.api('GET', '/api/parallel')).json.runs;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(r.json.id);
    expect(list[0].tasks).toEqual(r.json.tasks);
    const sessions = (await w.api('GET', '/api/state')).json.sessions as Array<{ id: string; title: string; cwd: string }>;
    expect(sessions.map((s) => s.title).sort()).toEqual(['parallel: a', 'parallel: b']);
    expect(sessions.find((s) => s.id === r.json.tasks[0].sessionId)!.cwd).toBe(fs.realpathSync.native(f.dirs[0]!));
  }, T);

  it('a bad second dir creates no session and no run', async () => {
    const w = await boot();
    const f = folders('a');
    const r = await w.api('POST', '/api/parallel', { body: { title: 'Run', repo: f.repo, tasks: [{ name: 'a', dir: f.dirs[0] }, { name: 'b', dir: path.join(f.base, 'missing') }] } });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('b');
    expect(sessionIds(w)).toEqual([]);
    expect((await w.api('GET', '/api/parallel')).json.runs).toEqual([]);
  }, T);

  it('a saved key in a second dir creates no session and no run', async () => {
    const redactor = new Redactor({ home: tmpDir(), env: { P_API_KEY: KEY }, keyEnvNames: () => ['P_API_KEY'] });
    const w = await boot([], { redactor });
    const f = folders('a', KEY);
    const r = await make(w, f, ['a', 'b']);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe(KEY_IN_IDENTITY);
    expect(sessionIds(w)).toEqual([]);
    expect((await w.api('GET', '/api/parallel')).json.runs).toEqual([]);
  }, T);

  it('a dir above the repo is refused', async () => {
    const w = await boot();
    const f = folders('a');
    const r = await w.api('POST', '/api/parallel', { body: { title: 'Run', repo: f.repo, tasks: [{ name: 'a', dir: f.dirs[0] }, { name: 'up', dir: f.base }] } });
    expect(r.status).toBe(400);
    expect(sessionIds(w)).toEqual([]);
  }, T);

  it('at the cap a message fails with the words, resume all is a 409, and a raised cap lets the next message go', async () => {
    const w = await boot([TURNS]);
    const f = folders('a');
    const r = await make(w, f, ['a'], { capUsd: 1 });
    const id = r.json.tasks[0].sessionId as string;
    w.store.appendLog(id, { type: 'turn_ended', data: { cost: 1.2 } });
    const words = 'has spent $1.20 of its $1.00 cap';
    await w.say(id, 'go');
    await until(() => w.rows(id, 'turn_failed').length === 1);
    expect(JSON.stringify(w.rows(id, 'turn_failed')[0]!.data)).toContain(words);
    expect(w.fake.log()).toEqual([]);
    const res = await w.api('POST', `/api/parallel/${r.json.id}/resume`, { body: {} });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain(words);
    expect((await w.api('POST', `/api/parallel/${r.json.id}/cap`, { body: { usd: 5 } })).status).toBe(200);
    expect((await w.api('GET', '/api/parallel')).json.runs[0].capUsd).toBe(5);
    await w.say(id, 'go again');
    await w.settled(id, 2);
    expect(w.fake.log().length).toBeGreaterThan(0);
    expect((await w.api('POST', `/api/parallel/${r.json.id}/cap`, { body: { usd: 0 } })).status).toBe(400);
    expect((await w.api('POST', `/api/parallel/${r.json.id}/cap`, { body: { usd: null } })).status).toBe(200);
    expect((await w.api('GET', '/api/parallel')).json.runs[0].capUsd).toBeUndefined();
  }, T);

  it('stop all stops the session mid-turn and reports the idle one', async () => {
    const w = await boot([{ ...TURNS, delayMs: 400 }]);
    const f = folders('a', 'b');
    const r = await make(w, f, ['a', 'b']);
    const [a, b] = r.json.tasks.map((t: { sessionId: string }) => t.sessionId) as string[];
    await w.say(a!, 'go');
    await until(() => w.fake.log().length > 0);
    const s = await w.api('POST', `/api/parallel/${r.json.id}/stop`, { body: {} });
    expect(s.status).toBe(200);
    expect(s.json).toEqual({ stopped: [a], idle: [b] });
    await until(() => (w.store.readLog(a!).at(-1)?.data as { status?: string } | undefined)?.status === 'idle', 15_000);
  }, T);

  it('resume all continues a task that Stop all paused with a resume question', async () => {
    const w = await boot([{ ...TURNS, text: 'REINS: done', delayMs: 300 }]);
    const f = folders('a');
    const r = await make(w, f, ['a']);
    const a = r.json.tasks[0].sessionId as string;
    const wf = path.join(f.dirs[0]!, 'a.reins.md');
    fs.writeFileSync(wf, `${FRONT}## phase go\n> do it\n`);
    expect((await w.post(a, 'run', { path: wf })).status).toBe(200);
    await w.answer(a, (await askedQuestion(w.store, a, 'trust')).id, 'y');
    await until(() => w.fake.log().length > 0);
    expect((await w.api('POST', `/api/parallel/${r.json.id}/stop`, { body: {} })).json.stopped).toEqual([a]);
    const q = await askedQuestion(w.store, a, 'resume', 15_000);
    const res = await w.api('POST', `/api/parallel/${r.json.id}/resume`, { body: {} });
    expect(res.status).toBe(200);
    expect(res.json.results).toEqual([{ name: 'a', result: 'resumed' }]);
    expect(w.rows(a, 'answer').some((x) => (x.data as { questionId: string; answer: string }).questionId === q.id && (x.data as { answer: string }).answer === 'resume')).toBe(true);
    await until(() => w.rows(a, 'run_finished').length > 0, 15_000);
  }, 40_000);

  it('resume all leaves a task waiting on a question that is not a resume', async () => {
    const w = await boot([{ ...TURNS, text: 'REINS: done' }]);
    const f = folders('a');
    const r = await make(w, f, ['a']);
    const a = r.json.tasks[0].sessionId as string;
    const wf = path.join(f.dirs[0]!, 'a.reins.md');
    fs.writeFileSync(wf, `${FRONT}## gate\nuntil: you approve\n\n## phase go\n> do it\n`);
    expect((await w.post(a, 'run', { path: wf })).status).toBe(200);
    await w.answer(a, (await askedQuestion(w.store, a, 'trust')).id, 'y');
    await askedQuestion(w.store, a, 'gate');
    const res = await w.api('POST', `/api/parallel/${r.json.id}/resume`, { body: {} });
    expect(res.json.results).toEqual([{ name: 'a', result: 'waiting' }]);
    expect(w.rows(a, 'answer').filter((x) => (x.data as { answer: string }).answer === 'resume')).toEqual([]);
  }, T);

  it('after a restart with one worktree deleted, resume all says gone, nothing and resumed', async () => {
    const dir = tmpDir();
    const file = path.join(tmpDir(), 'reins.db');
    const f = folders('a', 'b', 'c');
    const w1 = await boot([{ ...TURNS, text: 'REINS: done' }], { store: openStore(file), dir });
    const r = await make(w1, f, ['a', 'b', 'c']);
    const c = r.json.tasks[2].sessionId as string;
    fs.mkdirSync(path.join(f.dirs[2]!, 'blocks'));
    fs.writeFileSync(path.join(f.dirs[2]!, 'blocks', 'rp.reins.md'), RP);
    const wf = path.join(f.dirs[2]!, 'a.reins.md');
    fs.writeFileSync(wf, WITH_BLOCK);
    expect((await w1.post(c, 'run', { path: wf })).status).toBe(200);
    await w1.answer(c, (await askedQuestion(w1.store, c, 'trust')).id, 'y');
    await askedQuestion(w1.store, c, 'gate');
    await w1.srv.close();
    w1.store.close();
    fs.rmSync(f.dirs[0]!, { recursive: true, force: true });

    const w2 = await boot([], { store: openStore(file), dir, fake: w1.fake });
    expect((await w2.api('GET', '/api/parallel')).json.runs).toHaveLength(1);
    const res = await w2.api('POST', `/api/parallel/${r.json.id}/resume`, { body: {} });
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.json.results.map((x: { name: string; result: string }) => [x.name, x.result]));
    expect(by).toEqual({ a: 'gone', b: 'nothing', c: 'resumed' });
    expect(res.json.results[0].words).toBeTruthy();
    expect(res.json.results[1].words).toBeUndefined();
  }, T);

  it('forget removes the record and keeps the sessions; an unknown id is a 404', async () => {
    const w = await boot();
    const f = folders('a');
    const r = await make(w, f, ['a']);
    expect((await w.api('POST', `/api/parallel/${r.json.id}/forget`, { body: {} })).status).toBe(200);
    expect((await w.api('GET', '/api/parallel')).json.runs).toEqual([]);
    expect(sessionIds(w)).toHaveLength(1);
    const gone = await w.api('POST', `/api/parallel/${r.json.id}/forget`, { body: {} });
    expect(gone.status).toBe(404);
    expect(gone.json.error).toBe('No such parallel run.');
  }, T);

  it('/api/state keeps its keys', async () => {
    const w = await boot();
    await make(w, folders('a'), ['a']);
    expect(Object.keys((await w.api('GET', '/api/state')).json).sort()).toEqual(['engines', 'groups', 'providers', 'sessions']);
  }, T);
});
