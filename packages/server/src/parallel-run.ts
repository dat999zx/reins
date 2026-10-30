// The git half of a parallel run (worktrees, merge, gate, clean), moved from scripts/parallel.mjs and made async so no session's stream stalls on a git call.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { runCommand } from './commands.js';
import { under } from './session.js';

// Pinned copy of the store's shapes (M8 plan P1 to P3); S3 replaces it with an import.
export type ParallelPhase = 'setup' | 'running' | 'merging' | 'gating' | 'done' | 'failed' | 'interrupted';
export interface ParallelJobTask { name: string; branch: string; dir: string; playbook: string; model?: string; effort?: string }
export interface ParallelJob {
  repo: string; branch: string; head: string; folder: string;
  install?: string; gate?: string; gateRetry?: string; reports?: string;
  tasks: ParallelJobTask[];
  words: string; merged: string[]; notMerged: Array<{ name: string; why: string }>;
  conflict?: { task: string; files: string[]; why: string }; gateResult: 'pass' | 'fail' | 'not run';
}
type ParallelTask = { name: string; sessionId: string };
export type ParallelPatch = { phase?: ParallelPhase; tasks?: ParallelTask[]; job?: Partial<ParallelJob> };

export interface RunDeps { env: () => NodeJS.ProcessEnv; signal: AbortSignal; save(patch: ParallelPatch): void; timeoutMs?: number }

// ponytail: one timeout for install and gate; a field when a repo's gate passes an hour.
const JOB_MS = 60 * 60_000;
// Instruction files that git ignores but an agent needs. Not .claude/ or .mcp.json: they would raise a folder-trust question per worktree.
const IGNORED_BUT_NEEDED = ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md', 'KNOWL.md'];
// Ends a signing prompt or a stuck hook, which nobody could cancel.
const GIT_MS = 5 * 60_000;

const execFileP = promisify(execFile);
/** Async, never spawnSync: `git worktree add` on a big repo would stall every session's stream. */
const git = async (cwd: string, args: string[], d: RunDeps, o: { noSignal?: true } = {}): Promise<string> =>
  (await execFileP('git', args, { cwd, env: d.env(), windowsHide: true, encoding: 'utf8', timeout: GIT_MS, ...(o.noSignal ? {} : { signal: d.signal }) })).stdout.trim();

const lines = (s: string) => s.split('\n').filter(Boolean);
const last20 = (s: string) => s.trimEnd().split(/\r?\n/).slice(-20).join('\n');

export async function repoOf(cwd: string, d: RunDeps): Promise<string> {
  return path.resolve(await git(cwd, ['rev-parse', '--show-toplevel'], d)); // git prints forward slashes on Windows
}

/** Throws with the file list when the tree is not clean: a worktree starts from HEAD, so uncommitted edits would be invisible to it. */
export async function preflight(repo: string, d: RunDeps): Promise<{ branch: string; head: string }> {
  const dirty = await git(repo, ['status', '--porcelain'], d);
  if (dirty) throw new Error(`The working tree is not clean; commit or stash first:\n${dirty}`);
  return { branch: await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], d), head: await git(repo, ['rev-parse', 'HEAD'], d) };
}

/** One worktree per task on a flat branch name (a/b next to a would collide) from HEAD, one at a time (git locks .git/worktrees). Each one is saved as soon as it exists. */
export async function addWorktrees(repo: string, folder: string, id: string, tasks: Array<{ name: string; slug: string; playbook: string; model?: string; effort?: string }>, copy: string[], d: RunDeps): Promise<ParallelJobTask[]> {
  const soFar: ParallelJobTask[] = [];
  const realRepo = fs.realpathSync.native(repo);
  for (const t of tasks) {
    const branch = `par-${id}-${t.slug}`, dir = path.join(folder, t.slug);
    await git(repo, ['worktree', 'add', '-b', branch, dir, 'HEAD'], d);
    soFar.push({ name: t.name, branch, dir, playbook: t.playbook, ...(t.model === undefined ? {} : { model: t.model }), ...(t.effort === undefined ? {} : { effort: t.effort }) });
    d.save({ job: { tasks: [...soFar] } }); // a failure or a kill from here on leaves no worktree off the record
    for (const f of [...IGNORED_BUT_NEEDED, ...copy, t.playbook]) {
      const from = path.join(repo, f), to = path.join(dir, f);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      if (!under(fs.realpathSync.native(from), realRepo)) throw new Error(`${f} is outside the repo.`); // a link in the repo can lead out of it
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });
    }
  }
  return soFar;
}

/** Commits whatever the agent left in the worktree. Returns the changed files (empty: nothing to merge). */
export async function commitAll(task: ParallelJobTask, d: RunDeps): Promise<string[]> {
  await git(task.dir, ['add', '-A'], d);
  const files = lines(await git(task.dir, ['diff', '--cached', '--name-only'], d));
  if (files.length) await git(task.dir, ['commit', '-q', '-m', `parallel: ${task.name}\n\nParallel-Task: ${task.name}`], d);
  return files;
}

/** True when the task has commits (its branch moved past the start commit) and they are already inside the main folder's branch: a second Merge after a failed gate finds its tasks like this. A task that changed nothing is not merged. */
export async function alreadyMerged(repo: string, task: ParallelJobTask, head: string, d: RunDeps): Promise<boolean> {
  try {
    if (await git(repo, ['rev-parse', task.branch], d) === head) return false;
    await git(repo, ['merge-base', '--is-ancestor', task.branch, 'HEAD'], d);
    return true;
  } catch { return false; }
}

/** Merges the task branches into the main folder one at a time, in order. On the first conflict: abort, name the files, stop. A kill does not reach these git calls: it could leave index.lock or a half merge. */
export async function mergeInOrder(repo: string, tasks: ParallelJobTask[], d: RunDeps): Promise<{ merged: string[]; conflict?: { task: string; files: string[]; why: string } }> {
  const merged: string[] = [];
  for (const t of tasks) {
    if (d.signal.aborted) break;
    try {
      await git(repo, ['merge', '--no-ff', '-q', '-m', `parallel: merge ${t.name}`, t.branch], d, { noSignal: true });
      merged.push(t.name);
    } catch (e) {
      const files = lines(await git(repo, ['diff', '--name-only', '--diff-filter=U'], d, { noSignal: true }));
      await git(repo, ['merge', '--abort'], d, { noSignal: true });
      return { merged, conflict: { task: t.name, files, why: files.length ? '' : String((e as { stderr?: string }).stderr || (e as Error).message) } };
    }
  }
  return { merged };
}

/** The install command, in every worktree at once. A worktree must not share node_modules with the main checkout. */
export async function installAll(job: ParallelJob, d: RunDeps): Promise<void> {
  const cmd = job.install;
  if (!cmd) return;
  await Promise.all(job.tasks.map(async (t) => {
    const r = await runCommand(cmd, { cwd: t.dir, env: d.env, timeoutMs: d.timeoutMs ?? JOB_MS, signal: d.signal });
    if (r.exitCode !== 0) throw new Error(`task ${t.name}: install failed:\n${last20(r.stdout)}`);
  }));
}

/**
 * Commits every finished task, merges in order, stops on the first conflict, then runs the gate (and its retry once).
 * `ends` maps a task name to its end row type (`run_finished`, `run_stopped`) or undefined. Anything thrown goes up to the caller.
 */
export async function mergeRun(job: ParallelJob, ends: Record<string, string | undefined>, d: RunDeps): Promise<void> {
  d.save({ phase: 'merging', job: { words: '', conflict: undefined, gateResult: 'not run' } });
  // Once, whatever there is to merge: a rerun with nothing left must not gate someone's edits or another branch.
  const changed = await git(job.repo, ['status', '--porcelain'], d);
  if (changed) throw new Error(`The main tree changed while merging:\n${changed}`);
  if (await git(job.repo, ['rev-parse', '--abbrev-ref', 'HEAD'], d) !== job.branch) throw new Error(`The main folder is no longer on branch ${job.branch}.`);

  const ready: ParallelJobTask[] = [], notMerged: Array<{ name: string; why: string }> = [], done: string[] = [];
  for (const t of job.tasks) {
    if (ends[t.name] !== 'run_finished') { notMerged.push({ name: t.name, why: ends[t.name] ?? 'never ran' }); continue; }
    const files = await commitAll(t, d);
    if (files.length) ready.push(t);
    else if (await alreadyMerged(job.repo, t, job.head, d)) done.push(t.name);
    else if (await git(job.repo, ['rev-parse', t.branch], d) === job.head) notMerged.push({ name: t.name, why: 'no changes' });
    else ready.push(t); // committed by an earlier Merge, then stopped by a conflict or a kill
  }
  const r = await mergeInOrder(job.repo, ready, d);
  if (d.signal.aborted) return;
  const merged = [...done, ...r.merged];
  for (const t of ready) if (!r.merged.includes(t.name)) notMerged.push({ name: t.name, why: t.name === r.conflict?.task ? 'conflict' : 'after conflict' });
  if (r.conflict) {
    d.save({ phase: 'failed', job: { merged, notMerged, conflict: r.conflict, gateResult: 'not run', words: `Conflict in ${r.conflict.task}: ${r.conflict.files.join(', ') || r.conflict.why}. The merge was aborted.` } });
    return;
  }
  if (!job.gate || !merged.length) { // an abandoned run costs no gate
    d.save({ phase: 'done', job: { merged, notMerged, gateResult: 'not run' } });
    return;
  }
  d.save({ phase: 'gating', job: { merged, notMerged } });
  const gate = (cmd: string) => runCommand(cmd, { cwd: job.repo, env: d.env, timeoutMs: d.timeoutMs ?? JOB_MS, signal: d.signal });
  let g = await gate(job.gate);
  if (d.signal.aborted) return; // no save: the phase stays, and the next start reads `interrupted`
  if (g.exitCode !== 0) {
    // A load flake passes alone: the retry is the user's own command, once.
    g = await gate(job.gateRetry ?? job.gate);
    if (d.signal.aborted) return;
  }
  if (g.exitCode === 0) d.save({ phase: 'done', job: { gateResult: 'pass' } });
  else d.save({ phase: 'failed', job: { gateResult: 'fail', words: `The gate failed twice.\n${last20(g.stdout)}` } });
}

/**
 * Removes the merged worktrees and their branches. The server has closed the sessions first.
 * A task not merged stays on disk (not unfinished); a dirty, busy or undeletable one stays and is unfinished, so Clean can run again.
 */
export async function cleanRun(job: ParallelJob, d: RunDeps): Promise<{ removed: string[]; kept: Array<{ name: string; why: string }>; unfinished: boolean }> {
  const removed: string[] = [], kept: Array<{ name: string; why: string }> = [];
  let unfinished = false;
  for (const t of job.tasks) {
    if (await git(job.repo, ['branch', '--merged', 'HEAD', '--list', t.branch], d) === '') { kept.push({ name: t.name, why: `${t.branch} is not merged; ${t.dir} stays` }); continue; }
    let dirty = '';
    try { dirty = await git(t.dir, ['status', '--porcelain'], d); } catch { /* folder already gone: nothing to lose */ }
    if (dirty) { kept.push({ name: t.name, why: `${t.dir} has uncommitted changes; commit or discard there, then clean again` }); unfinished = true; continue; }
    copyReports(job, t);
    try { await git(job.repo, ['worktree', 'remove', '--force', t.dir], d); } catch (e) {
      if (!/not a working tree/.test(String((e as { stderr?: string }).stderr))) { kept.push({ name: t.name, why: `${t.dir} is still in use; run clean again` }); unfinished = true; continue; } // already gone: still drop the branch
    }
    try { await git(job.repo, ['branch', '-d', t.branch], d); } catch { kept.push({ name: t.name, why: `${t.branch} could not be deleted; run clean again` }); unfinished = true; continue; }
    removed.push(t.name);
  }
  try { fs.rmdirSync(job.folder); } catch { /* not empty, or gone */ }
  return { removed, kept, unfinished };
}

/** `<dir>/<reports>/*-report.md` to `<repo>/<reports>/reports/`: the folder is usually ignored, and the remove deletes ignored files. */
function copyReports(job: ParallelJob, t: ParallelJobTask): void {
  if (!job.reports) return;
  const from = path.join(t.dir, job.reports);
  if (!fs.existsSync(from)) return;
  for (const f of fs.readdirSync(from).filter((x) => x.endsWith('-report.md'))) {
    fs.mkdirSync(path.join(job.repo, job.reports, 'reports'), { recursive: true });
    fs.copyFileSync(path.join(from, f), path.join(job.repo, job.reports, 'reports', f));
  }
}
