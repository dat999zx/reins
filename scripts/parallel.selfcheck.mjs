// node scripts/parallel.selfcheck.mjs: the git half of parallel.mjs on a scratch repo (no server). Exits non-zero on a wrong answer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addWorktrees, clean, commitAll, mergeInOrder, preflight, registerBody, timing } from './parallel.mjs';

const rt = [{ name: 'A', dir: 'D:/w/a', branch: 'b', playbook: 'p.md' }, { name: 'B', dir: 'D:/w/b' }];
assert.deepEqual(registerBody({ title: 'T', capUsd: 5 }, 'D:/repo', 'r1', rt), { title: 'T', repo: 'D:/repo', capUsd: 5, tasks: [{ name: 'A', dir: 'D:/w/a' }, { name: 'B', dir: 'D:/w/b' }] }, 'title, cap and tasks');
const nb = registerBody({}, 'D:/repo', 'r1', rt);
assert.deepEqual(nb, { title: 'parallel r1', repo: 'D:/repo', tasks: [{ name: 'A', dir: 'D:/w/a' }, { name: 'B', dir: 'D:/w/b' }] }, 'default title');
assert.ok(!('capUsd' in nb), 'no capUsd key when absent');
const mt = [{ name: 'A', dir: 'D:/w/a', model: 'claude-haiku-5-5', effort: 'low' }, { name: 'B', dir: 'D:/w/b' }];
assert.deepEqual(registerBody({}, 'D:/repo', 'r1', mt).tasks, [{ name: 'A', dir: 'D:/w/a', model: 'claude-haiku-5-5', effort: 'low' }, { name: 'B', dir: 'D:/w/b' }], 'model and effort are kept when the task names them');

const rows = [{ type: 'user', ts: 1000 }, { type: 'tool', ts: 2000 }, { type: 'run_finished', ts: 91000 }, { type: 'run_stopped', ts: 99000 }];
assert.deepEqual(timing(rows), { start: 1000, end: 91000, type: 'run_finished', ms: 90000 }, 'the first end row wins');
assert.deepEqual(timing(rows.slice(0, 2)), { start: 1000, end: undefined, type: undefined, ms: undefined }, 'a running task has no end');

const base = mkdtempSync(join(tmpdir(), 'par-'));
const repo = join(base, 'repo'), wt = join(base, 'wt');
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fns = ['a', 'b', 'c'].map((n) => `export function ${n}() {\n  return 0;\n}\n`).join('\n// ----\n// ----\n// ----\n');
try {
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['core.autocrlf', 'false']]) g(repo, 'config', k, v);
  writeFileSync(join(repo, 'f.js'), fns);
  writeFileSync(join(repo, '.gitignore'), 'AGENTS.md\n');
  writeFileSync(join(repo, 'AGENTS.md'), 'rules');
  g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', 'init');

  writeFileSync(join(repo, 'dirty.txt'), 'x');
  assert.throws(() => preflight(repo), /dirty\.txt/, 'a dirty tree is refused and the file is named');
  rmSync(join(repo, 'dirty.txt'));
  const recorded = preflight(repo);

  const tasks = addWorktrees(repo, 'r1', wt, [{ name: 'Task A' }, { name: 'Task B' }, { name: 'task c' }]);
  assert.equal(readFileSync(join(tasks[0].dir, 'AGENTS.md'), 'utf8'), 'rules', 'an ignored instruction file is copied');
  assert.throws(() => addWorktrees(repo, 'r2', wt, [{ name: 'x y' }, { name: 'X-Y' }]), /repeats/, 'duplicate slugs are refused');

  const edit = (t, from, to) => writeFileSync(join(t.dir, 'f.js'), readFileSync(join(t.dir, 'f.js'), 'utf8').replace(from, to));
  edit(tasks[0], 'function a() {\n  return 0;', 'function a() {\n  return 1;');
  edit(tasks[1], 'function b() {\n  return 0;', 'function b() {\n  return 2;');
  assert.equal(commitAll(tasks[2]).length, 0, 'a task that changed nothing commits nothing');
  const ready = tasks.slice(0, 2);
  for (const t of ready) assert.deepEqual(commitAll(t), ['f.js']);
  const ok = mergeInOrder(repo, ready, recorded);
  assert.deepEqual(ok.merged, ['Task A', 'Task B'], 'edits to different functions of one file both merge');
  const merged = readFileSync(join(repo, 'f.js'), 'utf8');
  assert.ok(merged.includes('return 1;') && merged.includes('return 2;'), 'nothing lost');

  // a conflict: both change function c
  const t2 = addWorktrees(repo, 'r3', wt, [{ name: 'one' }, { name: 'two' }]);
  edit(t2[0], 'function c() {\n  return 0;', 'function c() {\n  return 7;');
  edit(t2[1], 'function c() {\n  return 0;', 'function c() {\n  return 8;');
  for (const t of t2) commitAll(t);
  const bad = mergeInOrder(repo, t2, recorded);
  assert.deepEqual(bad.merged, ['one']);
  assert.equal(bad.conflict.task, 'two');
  assert.deepEqual(bad.conflict.files, ['f.js'], 'the conflicting file is named');
  assert.equal(g(repo, 'status', '--porcelain'), '', 'the abort leaves the main tree clean');
  // clean: close the sessions, forget the group, then remove the folders
  const file = join(base, 'state.json');
  const calls = [];
  const fake = (dirs) => async (method, path) => { calls.push([method, path, existsSync(dirs[path.match(/sessions\/(s\d)/)?.[1]] ?? base)]); return {}; };
  const withIds = (ts) => ts.map((t, i) => ({ ...t, sessionId: `s${i}` }));
  const dirsOf = (ts) => Object.fromEntries(ts.map((t, i) => [`s${i}`, t.dir]));
  writeFileSync(file, JSON.stringify({ repo, parallelId: 'p1', tasks: withIds(tasks) }));
  await clean(file, fake(dirsOf(tasks)));
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [['POST', '/api/sessions/s0/close'], ['POST', '/api/sessions/s1/close'], ['POST', '/api/sessions/s2/close'], ['POST', '/api/parallel/p1/forget']], 'closes first, then forget');
  assert.ok(calls.slice(0, 3).every((c) => c[2]), 'each folder was still there when its session closed');
  assert.ok(tasks.every((t) => !existsSync(t.dir)), 'every merged worktree is removed');
  assert.ok(!existsSync(file), 'state.json is gone');

  // server down: the worktree goes, the state stays
  const t4 = addWorktrees(repo, 'r4', wt, [{ name: 'four' }]);
  writeFileSync(file, JSON.stringify({ repo, parallelId: 'p4', tasks: withIds(t4) }));
  await clean(file, undefined);
  assert.ok(!existsSync(t4[0].dir), 'worktree removed with the server down');
  assert.ok(existsSync(file), 'state.json is kept with the server down');

  // uncommitted work: nothing is removed, no forget, state kept
  const t5 = addWorktrees(repo, 'r5', wt, [{ name: 'five' }]);
  writeFileSync(join(t5[0].dir, 'wip.txt'), 'x');
  writeFileSync(file, JSON.stringify({ repo, parallelId: 'p5', tasks: withIds(t5) }));
  calls.length = 0;
  await clean(file, fake(dirsOf(t5)));
  assert.ok(existsSync(join(t5[0].dir, 'wip.txt')), 'a dirty worktree is kept with its file');
  assert.notEqual(g(repo, 'branch', '--list', t5[0].branch), '', 'its branch is kept');
  assert.ok(!calls.some((c) => c[1].endsWith('/forget')), 'no forget');
  assert.ok(existsSync(file), 'state.json is kept');
  console.log('parallel selfcheck: ok');
} finally {
  try { for (const l of g(repo, 'worktree', 'list', '--porcelain').split('\n')) if (l.startsWith('worktree ') && !l.endsWith(repo.replace(/\\\\/g, '/'))) g(repo, 'worktree', 'remove', '--force', l.slice(9)); } catch { /* scratch */ }
  rmSync(base, { recursive: true, force: true });
}
