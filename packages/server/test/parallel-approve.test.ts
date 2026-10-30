// M7 T3: the `approve` choice on a parallel run: body, column, seam, route.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBody, parallelSeam } from '../src/parallel.js';
import { openStore } from '../src/store.js';
import { boot, cleanup, tmpDir, type World } from './http-helpers.js';

afterEach(cleanup);

const T = 20_000;
const base = { title: 'Run', repo: path.resolve('repo'), tasks: [{ name: 'a', dir: path.resolve('a') }] };
const WORDS = 'approve must be "fence".';

/** `names` as folders under a fresh base, and a repo folder beside them. */
function folders(...names: string[]) {
  const root = tmpDir();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const dirs = names.map((n) => { const d = path.join(root, n); fs.mkdirSync(d); return d; });
  return { base: root, repo, dirs };
}
const make = (w: World, f: ReturnType<typeof folders>, names: string[], extra: Record<string, unknown> = {}) =>
  w.api('POST', '/api/parallel', { body: { title: 'Run', repo: f.repo, tasks: names.map((name, i) => ({ name, dir: f.dirs[i] })), ...extra } });

describe('parallel approve (M7 T3)', () => {
  it('checkBody keeps "fence", refuses any other value, and leaves it absent when absent', () => {
    expect(checkBody({ ...base, approve: 'fence' })).toMatchObject({ value: { approve: 'fence' } });
    expect(checkBody({ ...base, approve: 'all' })).toEqual({ error: WORDS });
    expect(checkBody({ ...base, approve: true })).toEqual({ error: WORDS });
    const r = checkBody(base);
    expect('value' in r && 'approve' in r.value).toBe(false);
  });

  it('the store reads approve back, only when set, and the seam answers it', () => {
    const s = openStore(':memory:');
    const a = s.createParallel({ id: 'a1', title: 'f', approve: 'fence', tasks: [{ name: 't', sessionId: 's1' }] });
    expect(a.approve).toBe('fence');
    expect(s.listParallel()[0]!.approve).toBe('fence');
    const b = s.createParallel({ id: 'b2', title: 'p', tasks: [{ name: 'u', sessionId: 's2' }] });
    expect(b).not.toHaveProperty('approve');
    const seam = parallelSeam(s);
    expect(seam.approve!('s1')).toBe('fence');
    expect(seam.approve!('s2')).toBeUndefined();
    expect(seam.approve!('nowhere')).toBeUndefined();
    s.close();
  });

  it('a store made before the column is migrated and keeps its row', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-approve-'));
    const file = path.join(dir, 'reins.db');
    const old = new DatabaseSync(file);
    old.exec('create table parallel_runs (id text primary key, title text not null, cap_usd real, tasks text not null, created_at integer not null)');
    old.prepare('insert into parallel_runs (id, title, cap_usd, tasks, created_at) values (?, ?, ?, ?, ?)').run('o1', 'old', null, '[]', 1);
    old.close();
    const s = openStore(file);
    expect(s.listParallel()).toEqual([{ id: 'o1', title: 'old', createdAt: 1, tasks: [] }]);
    s.createParallel({ id: 'n1', title: 'new', approve: 'fence', tasks: [] });
    expect(s.listParallel().find((r) => r.id === 'n1')!.approve).toBe('fence');
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the route stores approve fence, and refuses another word before any session exists', async () => {
    const w = await boot();
    const f = folders('a');
    const ok = await make(w, f, ['a'], { approve: 'fence' });
    expect(ok.status).toBe(200);
    expect((await w.api('GET', '/api/parallel')).json.runs[0].approve).toBe('fence');
    const g = folders('b');
    const w2 = await boot();
    const bad = await make(w2, g, ['b'], { approve: 'yes' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe(WORDS);
    expect(w2.store.listSessions()).toEqual([]);
  }, T);
});
