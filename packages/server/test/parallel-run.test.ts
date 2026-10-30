// M8 S2: the git half of a parallel run, merge and gate, clean, and the abort of a command.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from '../src/commands.js';
import { addWorktrees, alreadyMerged, cleanRun, commitAll, installAll, mergeInOrder, mergeRun, preflight, repoOf } from '../src/parallel-run.js';
import type { ParallelJob, ParallelJobTask, ParallelPatch, ParallelPhase, RunDeps } from '../src/parallel-run.js';
import { loopTmp } from './loop-harness.js';

vi.setConfig({ testTimeout: 60_000 });

const NODE = `"${process.execPath}"`;
const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fns = ['a', 'b', 'c'].map((n) => `export function ${n}() {\n  return 0;\n}\n`).join('\n// ----\n// ----\n// ----\n');

const bases: string[] = [];
afterEach(() => {
  for (const d of bases.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* scratch */ }
  }
});

/** A scratch repo with one tracked file, small gate scripts, and an ignored AGENTS.md, docs/plan and notes folder. */
function repo() {
  const base = loopTmp('par-run-');
  bases.push(base);
  const r = path.join(base, 'repo'), wt = path.join(base, 'wt');
  execFileSync('git', ['init', '-q', '-b', 'main', r]);
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['core.autocrlf', 'false']]) g(r, 'config', k!, v!);
  fs.writeFileSync(path.join(r, 'f.js'), fns);
  fs.writeFileSync(path.join(r, '.gitignore'), 'AGENTS.md\ndocs/plan\nnotes/\nlink\n');
  fs.writeFileSync(path.join(r, 'AGENTS.md'), 'rules');
  // Gate scripts: an optional first argument is a file that gets one line per run.
  const mark = 'import fs from "node:fs"; if (process.argv[2]) fs.appendFileSync(process.argv[2], "x\\n");';
  fs.writeFileSync(path.join(r, 'ok.mjs'), mark + 'console.log("fine");');
  fs.writeFileSync(path.join(r, 'bad.mjs'), mark + 'console.log("line one"); console.log("boom from the gate"); process.exitCode = 1;');
  fs.writeFileSync(path.join(r, 'sleep.mjs'), 'setInterval(() => {}, 1000);');
  fs.writeFileSync(path.join(r, 'mark.mjs'), 'import fs from "node:fs"; fs.writeFileSync("marker", "x");');
  fs.writeFileSync(path.join(r, 'nomark.mjs'), 'process.exitCode = 3; console.log("install broke");');
  g(r, 'add', '-A'); g(r, 'commit', '-q', '-m', 'init');
  return { base, repo: r, wt, head: g(r, 'rev-parse', 'HEAD') };
}
type R = ReturnType<typeof repo>;

function deps(saved: ParallelPatch[] = [], signal: AbortSignal = new AbortController().signal): RunDeps {
  return { env: () => process.env, signal, save: (p) => saved.push(p) };
}
const spec = (name: string, slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')) => ({ name, slug, playbook: 'p.md' });
const edit = (t: ParallelJobTask, from: string, to: string) => fs.writeFileSync(path.join(t.dir, 'f.js'), fs.readFileSync(path.join(t.dir, 'f.js'), 'utf8').replace(from, to));
const setC = (t: ParallelJobTask, n: number) => edit(t, 'function c() {\n  return 0;', `function c() {\n  return ${n};`);
const cmd = (script: string, mark?: string) => `${NODE} ${script}${mark ? ` "${mark}"` : ''}`;
const lineCount = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0);

const jobOf = (R: R, id: string, tasks: ParallelJobTask[], extra: Partial<ParallelJob> = {}): ParallelJob =>
  ({ repo: R.repo, branch: 'main', head: R.head, folder: path.join(R.wt, id), tasks, words: '', merged: [], notMerged: [], gateResult: 'not run', ...extra });
const FIN = 'run_finished';
const ends = (job: ParallelJob, over: Record<string, string | undefined> = {}) => ({ ...Object.fromEntries(job.tasks.map((t) => [t.name, FIN])), ...over }) as Record<string, string | undefined>;
/** The run row after a list of patches: the last phase, and the job merged key by key. */
const fold = (saved: ParallelPatch[]) => saved.reduce<{ phase?: ParallelPhase; job: Partial<ParallelJob> }>((a, p) => ({ ...(p.phase ? { phase: p.phase } : a.phase ? { phase: a.phase } : {}), job: { ...a.job, ...p.job } }), { job: {} });
const phases = (saved: ParallelPatch[]) => saved.flatMap((s) => (s.phase ? [s.phase] : []));

describe('runCommand abort', () => {
  it('an abort ends a sleeping child and the promise resolves', async () => {
    const R = repo();
    const ac = new AbortController();
    const t0 = Date.now();
    const p = runCommand(cmd('sleep.mjs'), { cwd: R.repo, signal: ac.signal, timeoutMs: 60_000 });
    setTimeout(() => ac.abort(), 500);
    const r = await p;
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r.exitCode).not.toBe(0);
  });

  it('an already aborted signal starts nothing', async () => {
    const R = repo();
    const ac = new AbortController();
    ac.abort();
    const r = await runCommand(cmd('mark.mjs'), { cwd: R.repo, signal: ac.signal });
    expect(r).toEqual({ exitCode: 1, stdout: '', stderr: '' });
    expect(fs.existsSync(path.join(R.repo, 'marker'))).toBe(false);
  });
});

describe('git half', () => {
  it('preflight names a dirty file and returns the branch and head', async () => {
    const R = repo();
    expect(await preflight(R.repo, deps())).toEqual({ branch: 'main', head: R.head });
    fs.writeFileSync(path.join(R.repo, 'dirty.txt'), 'x');
    await expect(preflight(R.repo, deps())).rejects.toThrow(/dirty\.txt/);
  });

  it('repoOf gives the repo from a sub-folder and rejects a plain folder', async () => {
    const R = repo();
    fs.mkdirSync(path.join(R.repo, 'sub'));
    expect(fs.realpathSync.native(await repoOf(path.join(R.repo, 'sub'), deps()))).toBe(fs.realpathSync.native(R.repo));
    const plain = loopTmp('par-plain-');
    bases.push(plain);
    await expect(repoOf(plain, deps())).rejects.toThrow();
  });

  it('addWorktrees copies the ignored instruction file, skips a missing one, copies a listed folder', async () => {
    const R = repo();
    fs.mkdirSync(path.join(R.repo, 'notes'));
    fs.writeFileSync(path.join(R.repo, 'notes', 'a.txt'), 'note');
    const tasks = await addWorktrees(R.repo, path.join(R.wt, 'r1'), 'r1', [spec('Task A'), spec('Task B')], ['nope.md', 'notes/'], deps());
    expect(tasks.map((t) => t.branch)).toEqual(['par-r1-task-a', 'par-r1-task-b']);
    expect(fs.readFileSync(path.join(tasks[0]!.dir, 'AGENTS.md'), 'utf8')).toBe('rules');
    expect(fs.existsSync(path.join(tasks[0]!.dir, 'nope.md'))).toBe(false);
    expect(fs.readFileSync(path.join(tasks[0]!.dir, 'notes', 'a.txt'), 'utf8')).toBe('note');
  });

  it('addWorktrees refuses a link in copy that leads out of the repo', async () => {
    const R = repo();
    const outside = path.join(R.base, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
    try { fs.symlinkSync(outside, path.join(R.repo, 'link'), 'junction'); } catch { return; } // no right to make a link here
    await expect(addWorktrees(R.repo, path.join(R.wt, 'r1'), 'r1', [spec('one')], ['link'], deps())).rejects.toThrow(/link is outside the repo\./);
  });

  it('addWorktrees saves each worktree as it is made: a failure on the second leaves the first on record and clean removes it (B9)', async () => {
    const R = repo();
    g(R.repo, 'branch', 'par-r1-b'); // the second worktree add fails on this
    const saved: ParallelPatch[] = [];
    await expect(addWorktrees(R.repo, path.join(R.wt, 'r1'), 'r1', [spec('a'), spec('b')], [], deps(saved))).rejects.toThrow();
    const soFar = saved.at(-1)!.job!.tasks!;
    expect(soFar.map((t) => t.name)).toEqual(['a']);
    expect(fs.existsSync(soFar[0]!.dir)).toBe(true);
    const out = await cleanRun(jobOf(R, 'r1', soFar), deps());
    expect(out.removed).toEqual(['a']);
    expect(fs.existsSync(soFar[0]!.dir)).toBe(false);
    expect(g(R.repo, 'branch', '--list', 'par-r1-a')).toBe('');
  });

  it('commitAll, mergeInOrder and alreadyMerged: two edits to one file both land', async () => {
    const R = repo();
    const tasks = await addWorktrees(R.repo, path.join(R.wt, 'r1'), 'r1', [spec('Task A'), spec('Task B'), spec('task c')], [], deps());
    edit(tasks[0]!, 'function a() {\n  return 0;', 'function a() {\n  return 1;');
    edit(tasks[1]!, 'function b() {\n  return 0;', 'function b() {\n  return 2;');
    expect(await commitAll(tasks[2]!, deps())).toEqual([]);
    const ready = tasks.slice(0, 2);
    for (const t of ready) expect(await commitAll(t, deps())).toEqual(['f.js']);
    const ok = await mergeInOrder(R.repo, ready, deps());
    expect(ok.merged).toEqual(['Task A', 'Task B']);
    expect(ok.conflict).toBeUndefined();
    const merged = fs.readFileSync(path.join(R.repo, 'f.js'), 'utf8');
    expect(merged.includes('return 1;') && merged.includes('return 2;')).toBe(true);
    expect(await alreadyMerged(R.repo, tasks[0]!, R.head, deps())).toBe(true);
    expect(await alreadyMerged(R.repo, tasks[1]!, R.head, deps())).toBe(true);
    expect(await alreadyMerged(R.repo, tasks[2]!, R.head, deps())).toBe(false);
  });

  it('mergeInOrder names the conflicting file, aborts, and leaves the main tree clean', async () => {
    const R = repo();
    const t = await addWorktrees(R.repo, path.join(R.wt, 'r1'), 'r1', [spec('one'), spec('two')], [], deps());
    setC(t[0]!, 7); setC(t[1]!, 8);
    for (const x of t) await commitAll(x, deps());
    const bad = await mergeInOrder(R.repo, t, deps());
    expect(bad.merged).toEqual(['one']);
    expect(bad.conflict!.task).toBe('two');
    expect(bad.conflict!.files).toEqual(['f.js']);
    expect(g(R.repo, 'status', '--porcelain')).toBe('');
  });

  it('installAll runs the command in every worktree; a failing one rejects with the task name', async () => {
    const R = repo();
    const t = await addWorktrees(R.repo, path.join(R.wt, 'r1'), 'r1', [spec('one'), spec('two')], [], deps());
    await installAll(jobOf(R, 'r1', t), deps()); // no install: nothing runs
    await installAll(jobOf(R, 'r1', t, { install: cmd('mark.mjs') }), deps());
    for (const x of t) expect(fs.existsSync(path.join(x.dir, 'marker'))).toBe(true);
    const err = await installAll(jobOf(R, 'r1', t, { install: cmd('nomark.mjs') }), deps()).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^task (one|two): install failed:\ninstall broke/);
  });
});

describe('mergeRun', () => {
  async function ready(names: string[], extra: Partial<ParallelJob> = {}, edits: Record<string, number | undefined> = {}) {
    const R = repo();
    const t = await addWorktrees(R.repo, path.join(R.wt, 'r1'), 'r1', names.map((n) => spec(n)), [], deps());
    const letters = ['a', 'b'];
    t.forEach((x, i) => {
      const n = edits[x.name];
      if (n !== undefined) setC(x, n);
      else if (!(x.name in edits)) edit(x, `function ${letters[i]}() {\n  return 0;`, `function ${letters[i]}() {\n  return 1;`);
    });
    return { R, job: jobOf(R, 'r1', t, extra) };
  }

  it('no gate: merging then done, gate not run', async () => {
    const { job } = await ready(['one', 'two']);
    const saved: ParallelPatch[] = [];
    await mergeRun(job, ends(job), deps(saved));
    expect(phases(saved)).toEqual(['merging', 'done']);
    const f = fold(saved);
    expect(f.job.gateResult).toBe('not run');
    expect(f.job.merged).toEqual(['one', 'two']);
    expect(f.job.notMerged).toEqual([]);
  });

  it('gate passes: merging, gating, done, pass', async () => {
    const { R, job } = await ready(['one', 'two'], { gate: 'x' });
    job.gate = cmd('ok.mjs', path.join(R.base, 'gate.log'));
    const saved: ParallelPatch[] = [];
    await mergeRun(job, ends(job), deps(saved));
    expect(phases(saved)).toEqual(['merging', 'gating', 'done']);
    expect(fold(saved).job.gateResult).toBe('pass');
    expect(lineCount(path.join(R.base, 'gate.log'))).toBe(1);
  });

  it('gate fails, gateRetry passes: the retry ran, done, pass', async () => {
    const { R, job } = await ready(['one', 'two']);
    job.gate = cmd('bad.mjs', path.join(R.base, 'gate.log'));
    job.gateRetry = cmd('ok.mjs', path.join(R.base, 'retry.log'));
    const saved: ParallelPatch[] = [];
    await mergeRun(job, ends(job), deps(saved));
    expect(lineCount(path.join(R.base, 'gate.log'))).toBe(1);
    expect(lineCount(path.join(R.base, 'retry.log'))).toBe(1);
    expect(phases(saved).at(-1)).toBe('done');
    expect(fold(saved).job.gateResult).toBe('pass');
  });

  it('gate fails, no gateRetry: the gate ran twice, failed, fail, words hold its last output', async () => {
    const { R, job } = await ready(['one', 'two']);
    job.gate = cmd('bad.mjs', path.join(R.base, 'gate.log'));
    const saved: ParallelPatch[] = [];
    await mergeRun(job, ends(job), deps(saved));
    expect(lineCount(path.join(R.base, 'gate.log'))).toBe(2);
    const f = fold(saved);
    expect(f.phase).toBe('failed');
    expect(f.job.gateResult).toBe('fail');
    expect(f.job.words).toMatch(/^The gate failed twice\.\n/);
    expect(f.job.words).toContain('boom from the gate');
  });

  it('a conflict: failed, conflict.task set, gate not run', async () => {
    const { R, job } = await ready(['one', 'two'], {}, { one: 7, two: 8 });
    job.gate = cmd('ok.mjs', path.join(R.base, 'gate.log'));
    const saved: ParallelPatch[] = [];
    await mergeRun(job, ends(job), deps(saved));
    const f = fold(saved);
    expect(f.phase).toBe('failed');
    expect(f.job.conflict!.task).toBe('two');
    expect(f.job.gateResult).toBe('not run');
    expect(f.job.merged).toEqual(['one']);
    expect(f.job.notMerged).toEqual([{ name: 'two', why: 'conflict' }]);
    expect(f.job.words).toBe('Conflict in two: f.js. The merge was aborted.');
    expect(lineCount(path.join(R.base, 'gate.log'))).toBe(0);
  });

  it('a stopped task and a task that never ran are listed, and the run ends done', async () => {
    const { job } = await ready(['one', 'two', 'three']);
    const saved: ParallelPatch[] = [];
    await mergeRun(job, { one: FIN, two: 'run_stopped', three: undefined }, deps(saved));
    const f = fold(saved);
    expect(f.phase).toBe('done');
    expect(f.job.merged).toEqual(['one']);
    expect(f.job.notMerged).toEqual([{ name: 'two', why: 'run_stopped' }, { name: 'three', why: 'never ran' }]);
  });

  it('nothing merged, with a gate: the gate does not run; done, not run', async () => {
    const { R, job } = await ready(['one'], {}, { one: undefined });
    job.gate = cmd('ok.mjs', path.join(R.base, 'gate.log'));
    const saved: ParallelPatch[] = [];
    await mergeRun(job, ends(job), deps(saved));
    const f = fold(saved);
    expect(f.phase).toBe('done');
    expect(f.job.gateResult).toBe('not run');
    expect(f.job.notMerged).toEqual([{ name: 'one', why: 'no changes' }]);
    expect(lineCount(path.join(R.base, 'gate.log'))).toBe(0);
  });

  it('a rerun after a failed gate counts the tasks as merged', async () => {
    const { R, job } = await ready(['one', 'two']);
    job.gate = cmd('bad.mjs');
    const first: ParallelPatch[] = [];
    await mergeRun(job, ends(job), deps(first));
    expect(fold(first).phase).toBe('failed');
    job.gate = cmd('ok.mjs', path.join(R.base, 'gate.log'));
    const saved: ParallelPatch[] = [];
    await mergeRun(job, ends(job), deps(saved));
    const f = fold(saved);
    expect(f.phase).toBe('done');
    expect(f.job.merged).toEqual(['one', 'two']);
    expect(f.job.gateResult).toBe('pass');
    expect(f.job.words).toBe('');
    expect(lineCount(path.join(R.base, 'gate.log'))).toBe(1);
  });

  it('a rerun after a conflict lands the task that was committed and not merged; a task still at head stays no changes', async () => {
    const { job } = await ready(['one', 'two', 'three', 'four'], {}, { one: 7, two: 8, three: undefined, four: undefined });
    edit(job.tasks[2]!, 'function b() {\n  return 0;', 'function b() {\n  return 5;');
    const first: ParallelPatch[] = [];
    await mergeRun(job, ends(job), deps(first));
    const a = fold(first);
    expect(a.phase).toBe('failed');
    expect(a.job.notMerged).toEqual([{ name: 'four', why: 'no changes' }, { name: 'two', why: 'conflict' }, { name: 'three', why: 'after conflict' }]);
    // The owner gives up on task two; task three was committed by the first Merge, so commitAll returns no files for it.
    const saved: ParallelPatch[] = [];
    await mergeRun(job, ends(job, { two: 'run_stopped' }), deps(saved));
    const f = fold(saved);
    expect(f.phase).toBe('done');
    expect(f.job.merged).toEqual(['one', 'three']);
    expect(f.job.notMerged).toEqual([{ name: 'two', why: 'run_stopped' }, { name: 'four', why: 'no changes' }]);
    expect(f.job.conflict).toBeUndefined();
    expect(fs.readFileSync(path.join(job.repo, 'f.js'), 'utf8')).toContain('return 5;');
  });

  it('a dirty main tree or another branch rejects, on a first Merge and on a rerun, and the gate does not run', async () => {
    const { R, job } = await ready(['one']);
    job.gate = cmd('ok.mjs', path.join(R.base, 'gate.log'));
    fs.writeFileSync(path.join(R.repo, 'dirty.txt'), 'x');
    await expect(mergeRun(job, ends(job), deps())).rejects.toThrow(/^The main tree changed while merging:\n.*dirty\.txt/);
    fs.rmSync(path.join(R.repo, 'dirty.txt'));
    g(R.repo, 'checkout', '-q', '-b', 'other');
    await expect(mergeRun(job, ends(job), deps())).rejects.toThrow('The main folder is no longer on branch main.');
    g(R.repo, 'checkout', '-q', 'main');
    // A rerun with nothing left to merge.
    await mergeRun(job, ends(job), deps());
    expect(lineCount(path.join(R.base, 'gate.log'))).toBe(1);
    fs.writeFileSync(path.join(R.repo, 'dirty.txt'), 'x');
    await expect(mergeRun(job, ends(job), deps())).rejects.toThrow(/dirty\.txt/);
    fs.rmSync(path.join(R.repo, 'dirty.txt'));
    g(R.repo, 'checkout', '-q', 'other');
    await expect(mergeRun(job, ends(job), deps())).rejects.toThrow('The main folder is no longer on branch main.');
    expect(lineCount(path.join(R.base, 'gate.log'))).toBe(1);
  });

  it('an abort during the gate ends it inside 15 s and nothing is saved after gating', async () => {
    const { job } = await ready(['one'], {});
    job.gate = cmd('sleep.mjs');
    const ac = new AbortController();
    const saved: ParallelPatch[] = [];
    const d: RunDeps = { env: () => process.env, signal: ac.signal, save: (p) => { saved.push(p); if (p.phase === 'gating') setTimeout(() => ac.abort(), 500); } };
    const t0 = Date.now();
    await mergeRun(job, ends(job), d);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(phases(saved)).toEqual(['merging', 'gating']);
  });
});

describe('cleanRun', () => {
  it('removes a merged worktree with its branch, keeps an unmerged one, and removes the empty run folder', async () => {
    const R = repo();
    const t = await addWorktrees(R.repo, path.join(R.wt, 'r1'), 'r1', [spec('one'), spec('two')], [], deps());
    edit(t[1]!, 'function a() {\n  return 0;', 'function a() {\n  return 1;');
    await commitAll(t[1]!, deps()); // task two moves past HEAD and is not merged
    const out = await cleanRun(jobOf(R, 'r1', t), deps());
    expect(out.removed).toEqual(['one']);
    expect(out.kept).toEqual([{ name: 'two', why: `${t[1]!.branch} is not merged; ${t[1]!.dir} stays` }]);
    expect(out.unfinished).toBe(false);
    expect(fs.existsSync(t[0]!.dir)).toBe(false);
    expect(g(R.repo, 'branch', '--list', t[0]!.branch)).toBe('');
    expect(fs.existsSync(t[1]!.dir)).toBe(true);
    expect(fs.existsSync(path.join(R.wt, 'r1'))).toBe(true);
    const again = await cleanRun(jobOf(R, 'r1', [t[0]!]), deps()); // branch gone: git cannot list it as merged
    expect(again.removed).toEqual([]);
  });

  it('removes the run folder when every task is gone', async () => {
    const R = repo();
    const t = await addWorktrees(R.repo, path.join(R.wt, 'r1'), 'r1', [spec('one')], [], deps());
    const out = await cleanRun(jobOf(R, 'r1', t), deps());
    expect(out.removed).toEqual(['one']);
    expect(fs.existsSync(path.join(R.wt, 'r1'))).toBe(false);
  });

  it('keeps a dirty worktree with its file and its branch, and is unfinished', async () => {
    const R = repo();
    const t = await addWorktrees(R.repo, path.join(R.wt, 'r1'), 'r1', [spec('five')], [], deps());
    fs.writeFileSync(path.join(t[0]!.dir, 'wip.txt'), 'x');
    const out = await cleanRun(jobOf(R, 'r1', t), deps());
    expect(out.removed).toEqual([]);
    expect(out.kept).toEqual([{ name: 'five', why: `${t[0]!.dir} has uncommitted changes; commit or discard there, then clean again` }]);
    expect(out.unfinished).toBe(true);
    expect(fs.existsSync(path.join(t[0]!.dir, 'wip.txt'))).toBe(true);
    expect(g(R.repo, 'branch', '--list', t[0]!.branch)).not.toBe('');
  });

  it('copies a report from an ignored folder to <repo>/<reports>/reports/ before it removes the worktree', async () => {
    const R = repo();
    const t = await addWorktrees(R.repo, path.join(R.wt, 'r1'), 'r1', [spec('one')], [], deps());
    fs.mkdirSync(path.join(t[0]!.dir, 'docs', 'plan'), { recursive: true });
    fs.writeFileSync(path.join(t[0]!.dir, 'docs', 'plan', 'm8-s2-report.md'), 'done');
    fs.writeFileSync(path.join(t[0]!.dir, 'docs', 'plan', 'notes.md'), 'not a report');
    const out = await cleanRun(jobOf(R, 'r1', t, { reports: 'docs/plan' }), deps());
    expect(out.removed).toEqual(['one']);
    expect(fs.readFileSync(path.join(R.repo, 'docs', 'plan', 'reports', 'm8-s2-report.md'), 'utf8')).toBe('done');
    expect(fs.existsSync(path.join(R.repo, 'docs', 'plan', 'reports', 'notes.md'))).toBe(false);
    expect(fs.existsSync(t[0]!.dir)).toBe(false);
  });
});
