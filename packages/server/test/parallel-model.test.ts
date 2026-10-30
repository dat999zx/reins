// M6 T1: a model and a reasoning level per parallel task (checkBody, and the routes over real HTTP).
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { checkBody } from '../src/parallel.js';
import { boot, cleanup, tmpDir, type World } from './http-helpers.js';

afterEach(cleanup);

const T = 20_000;

/** `names` as folders under a fresh base, and a repo folder beside them. */
function folders(...names: string[]) {
  const base = tmpDir();
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  const dirs = names.map((n) => { const d = path.join(base, n); fs.mkdirSync(d); return d; });
  return { base, repo, dirs };
}

const dirA = path.resolve('/m6-a');
const dirB = path.resolve('/m6-b');
const body = (task: Record<string, unknown>) => ({ title: 'Run', repo: path.resolve('/m6-repo'), tasks: [{ name: 'a', dir: dirA, ...task }] });

describe('checkBody model and effort (M6 T1)', () => {
  it('refuses a model that is not a non-empty string', () => {
    expect(checkBody(body({ model: 5 }))).toEqual({ error: 'task a: model must be a string.' });
    expect(checkBody(body({ model: '' }))).toEqual({ error: 'task a: model must be a string.' });
  });
  it('refuses an effort that is not a non-empty string', () => {
    expect(checkBody(body({ effort: 5 }))).toEqual({ error: 'task a: effort must be a string.' });
  });
  it('refuses a model with a control character or over 400 chars', () => {
    const words = { error: 'task a: model must be a short name with no control characters.' };
    expect(checkBody(body({ model: 'a\nb' }))).toEqual(words);
    expect(checkBody(body({ model: 'x'.repeat(401) }))).toEqual(words);
  });
  it('keeps model and effort on the task item only when given', () => {
    const kept = checkBody(body({ model: 'claude-haiku-5-5', effort: 'low' })) as { value: { tasks: Array<Record<string, unknown>> } };
    expect(kept.value.tasks[0]).toEqual({ name: 'a', dir: dirA, model: 'claude-haiku-5-5', effort: 'low' });
    const bare = checkBody({ ...body({}), tasks: [{ name: 'a', dir: dirA }, { name: 'b', dir: dirB }] }) as { value: { tasks: Array<Record<string, unknown>> } };
    for (const t of bare.value.tasks) expect(Object.keys(t)).toEqual(['name', 'dir']);
  });
});

describe('parallel routes with a model per task (M6 T1)', () => {
  const make = (w: World, f: ReturnType<typeof folders>, tasks: Array<Record<string, unknown>>) =>
    w.api('POST', '/api/parallel', { body: { title: 'Run', repo: f.repo, tasks: tasks.map((t, i) => ({ name: i ? 'b' : 'a', dir: f.dirs[i], ...t })) } });
  const nothingMade = async (w: World) => {
    expect(w.store.listSessions()).toEqual([]);
    expect((await w.api('GET', '/api/parallel')).json.runs).toEqual([]);
  };

  it('an unknown bare model is refused and nothing is created', async () => {
    const w = await boot();
    const r = await make(w, folders('a', 'b'), [{}, { model: 'claude-nope-9' }]);
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('task b');
    expect(r.json.error).toContain("Unknown model for this session's provider.");
    await nothingMade(w);
  }, T);

  it('an unknown reasoning level is refused and nothing is created', async () => {
    const w = await boot();
    const r = await make(w, folders('a', 'b'), [{}, { effort: 'turbo' }]);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('task b: Unknown reasoning level.');
    await nothingMade(w);
  }, T);

  it('a model of a provider that is not installed is refused', async () => {
    const w = await boot();
    const r = await make(w, folders('a', 'b'), [{}, { model: 'zz-no-such:x' }]);
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/^task b: Unknown model/);
    await nothingMade(w);
  }, T);

  it('a task with a model and effort gets them, a task without keeps the defaults', async () => {
    const w = await boot();
    const f = folders('a', 'b');
    const r = await make(w, f, [{ model: 'claude-haiku-5-5', effort: 'low' }, {}]);
    expect(r.status).toBe(200);
    const sessions = (await w.api('GET', '/api/state')).json.sessions as Array<{ id: string; model: string; effort: string }>;
    const a = sessions.find((s) => s.id === r.json.tasks[0].sessionId)!;
    const b = sessions.find((s) => s.id === r.json.tasks[1].sessionId)!;
    expect([a.model, a.effort]).toEqual(['claude-haiku-5-5', 'low']);
    expect([b.model, b.effort]).toEqual(['claude-sonnet-5-5', 'medium']);
  }, T);

  it('a typed provider:model is accepted although no list has it', async () => {
    const w = await boot();
    const r = await make(w, folders('a'), [{ model: 'claude-code:claude-x-1' }]);
    expect(r.status).toBe(200);
    const sessions = (await w.api('GET', '/api/state')).json.sessions as Array<{ id: string; model: string }>;
    expect(sessions.find((s) => s.id === r.json.tasks[0].sessionId)!.model).toBe('claude-x-1');
  }, T);
});
