// M6 T3b: closing a session frees its folder. On Windows an open child process holds its cwd, so a folder can only be removed after close.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { folderGone } from '../src/parallel.js';
import { boot, cleanup, tmpDir } from './http-helpers.js';

afterEach(cleanup);

const T = 20_000;
const TURNS = { fixture: 'claude-2.1.281-turns.jsonl', turn: 0 };

/** `names` as folders under a fresh base, and a repo folder beside them. */
function folders(...names: string[]) {
  const base = tmpDir();
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  const dirs = names.map((n) => { const d = path.join(base, n); fs.mkdirSync(d); return d; });
  return { base, repo, dirs };
}

describe('close frees the folder (M6 T3b)', () => {
  it('after close the task folder can be removed', async () => {
    const w = await boot([TURNS]);
    const f = folders('a');
    const r = await w.api('POST', '/api/parallel', { body: { title: 'Run', repo: f.repo, tasks: [{ name: 'a', dir: f.dirs[0] }] } });
    expect(r.status).toBe(200);
    const id = r.json.tasks[0].sessionId as string;
    await w.say(id, 'go');
    await w.settled(id, 1);
    expect((await w.api('POST', `/api/sessions/${id}/close`, { body: {} })).status).toBe(200);
    expect(w.rows(id, 'closed')).toHaveLength(1);
    // the fake kills its child just before it exits: a short retry covers that race
    expect(() => fs.rmSync(f.dirs[0]!, { recursive: true, maxRetries: 3, retryDelay: 200 })).not.toThrow();
    expect(folderGone(f.dirs[0]!)).toBe(true);
  }, T);
});
