#!/usr/bin/env node
// Runs several tasks at once, each in its own git worktree and its own Reins session, then merges them in order.
//   node scripts/parallel.mjs start tasks.json [--dir <folder for the worktrees>]
//   node scripts/parallel.mjs status <state.json>
//   node scripts/parallel.mjs merge  <state.json>      commits every finished task, merges in order, stops on the first conflict, then builds and runs the tests
//   node scripts/parallel.mjs clean  <state.json>      removes worktrees and branches once every task is merged
// tasks.json: { "tasks": [{ "name": "login", "playbook": "plans/login.reins.md" }], "copy": ["docs/spec.md"] }
// Needs a running `reins serve` (its port and token are read from ~/.reins/serve.lock). Each session asks its own trust questions in the app: answer them there.
// ponytail: the session API is driven over HTTP and polled; no server change, no UI. A group-per-run view, a total USD cap and resume after a server restart are not built.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
// Instruction files that git ignores but an agent needs. Not .claude/ or .mcp.json: they would raise a folder-trust question per worktree.
export const IGNORED_BUT_NEEDED = ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md', 'KNOWL.md'];

/** Throws with the file list when the tree is not clean: a worktree starts from HEAD, so uncommitted edits would be invisible to it. */
export function preflight(repo) {
  const dirty = git(repo, 'status', '--porcelain');
  if (dirty) throw new Error(`The working tree is not clean; commit or stash first:\n${dirty}`);
  return { branch: git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), head: git(repo, 'rev-parse', 'HEAD') };
}

/** One worktree per task on a flat branch name (a/b next to a would collide) from HEAD. Duplicate slugs are refused. */
export function addWorktrees(repo, runId, root, tasks, copy = []) {
  const seen = new Set();
  return tasks.map((t) => {
    const s = slug(t.name);
    if (!s || seen.has(s)) throw new Error(`Task name "${t.name}" is empty or repeats another once lower-cased.`);
    seen.add(s);
    const branch = `par-${runId}-${s}`, dir = join(root, runId, s);
    git(repo, 'worktree', 'add', '-b', branch, dir, 'HEAD');
    for (const f of [...IGNORED_BUT_NEEDED, ...copy, ...(t.playbook ? [t.playbook] : [])]) {
      const from = join(repo, f), to = join(dir, f);
      if (!existsSync(from) || existsSync(to)) continue;
      mkdirSync(dirname(to), { recursive: true });
      (/[\\/]$/.test(f) ? cpSync : copyFileSync)(from, to);
    }
    return { ...t, branch, dir };
  });
}

/** Commits whatever the agent left in the worktree. Returns the changed files (empty: nothing to merge). */
export function commitAll(task) {
  git(task.dir, 'add', '-A');
  const files = git(task.dir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
  if (files.length) git(task.dir, 'commit', '-q', '-m', `parallel: ${task.name}\n\nParallel-Task: ${task.name}`);
  return files;
}

/** Merges the task branches into the main folder one at a time, in order. On the first conflict: abort, name the files, stop. */
export function mergeInOrder(repo, tasks, recorded) {
  const merged = [];
  for (const t of tasks) {
    if (git(repo, 'status', '--porcelain')) throw new Error(`The main tree changed while merging:\n${git(repo, 'status', '--porcelain')}`);
    if (git(repo, 'rev-parse', '--abbrev-ref', 'HEAD') !== recorded.branch) throw new Error(`The main folder is no longer on branch ${recorded.branch}.`);
    try {
      git(repo, 'merge', '--no-ff', '-q', '-m', `parallel: merge ${t.name}`, t.branch);
      merged.push(t.name);
    } catch (e) {
      const files = git(repo, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
      git(repo, 'merge', '--abort');
      return { merged, conflict: { task: t.name, files, why: files.length ? '' : String(e.stderr || e.message) } };
    }
  }
  return { merged };
}

function server() {
  const lock = join(homedir(), '.reins', 'serve.lock');
  if (!existsSync(lock)) throw new Error('No running `reins serve` (no ~/.reins/serve.lock).');
  const { port, token } = JSON.parse(readFileSync(lock, 'utf8'));
  return async (method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  };
}

const sh = (cmd, cwd) => new Promise((ok, no) => spawn(cmd, { cwd, shell: true, stdio: 'ignore' }).on('exit', (c) => (c === 0 ? ok() : no(new Error(`${cmd} failed (${c}) in ${cwd}`)))));

async function ended(api, t) {
  const { rows } = await api('GET', `/api/sessions/${t.sessionId}/log?after=0`);
  const r = rows.find((x) => x.type === 'run_finished' || x.type === 'run_stopped');
  return r ? r.type : undefined;
}

async function start(file, dir) {
  const repo = git(process.cwd(), 'rev-parse', '--show-toplevel');
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  const base = preflight(repo);
  const runId = Date.now().toString(36);
  const root = resolve(dir ?? join(repo, '..', '.reins-par'));
  const tasks = addWorktrees(repo, runId, root, spec.tasks, spec.copy);
  const state = join(root, runId, 'state.json');
  const save = () => writeFileSync(state, JSON.stringify({ repo, ...base, runId, tasks }, null, 2));
  save();
  console.log(`parallel: ${tasks.length} worktrees under ${join(root, runId)}; installing (npm ci + build) in parallel`);
  // A worktree must NOT share node_modules with the main checkout: @reins/core would resolve to main's copy for typecheck, server build and app bundle.
  await Promise.all(tasks.map((t) => sh('npm ci && npm run build', t.dir)));
  const api = server();
  for (const t of tasks) {
    t.sessionId = (await api('POST', '/api/sessions', { cwd: t.dir, title: `parallel: ${t.name}` })).id;
    if (t.playbook) await api('POST', `/api/sessions/${t.sessionId}/run`, { path: t.playbook });
    else await api('POST', `/api/sessions/${t.sessionId}/message`, { text: t.prompt });
    save();
    console.log(`  ${t.name}: session ${t.sessionId} started`);
  }
  console.log(`\nAnswer the trust questions in the app (one set per session). State: ${state}`);
}

async function status(file) {
  const s = JSON.parse(readFileSync(file, 'utf8')), api = server();
  for (const t of s.tasks) console.log(`${t.name.padEnd(24)} ${(await ended(api, t)) ?? 'running'}`);
}

async function merge(file) {
  const s = JSON.parse(readFileSync(file, 'utf8')), api = server();
  const ready = [];
  for (const t of s.tasks) {
    const e = await ended(api, t);
    if (e !== 'run_finished') { console.log(`skip ${t.name}: ${e ?? 'still running'}`); continue; }
    const files = commitAll(t);
    console.log(`commit ${t.name}: ${files.length} file(s)${files.length ? `\n  ${files.join('\n  ')}` : ''}`);
    if (files.length) ready.push(t);
  }
  const r = mergeInOrder(s.repo, ready, s);
  console.log(`merged: ${r.merged.join(', ') || 'none'}`);
  if (r.conflict) { console.log(`CONFLICT in ${r.conflict.task}: ${r.conflict.files.join(', ') || r.conflict.why}\nThe merge was aborted; resolve by hand, then run merge again.`); process.exitCode = 2; return; }
  await sh('npm run build', s.repo);
  console.log('gate: node scripts/test-affected.mjs --all');
  await sh('node scripts/test-affected.mjs --all', s.repo);
}

function clean(file) {
  const s = JSON.parse(readFileSync(file, 'utf8'));
  for (const t of s.tasks) {
    if (git(s.repo, 'branch', '--merged', 'HEAD', '--list', t.branch) === '') { console.log(`keep ${t.name}: ${t.branch} is not merged`); continue; }
    git(s.repo, 'worktree', 'remove', '--force', t.dir);
    git(s.repo, 'branch', '-d', t.branch);
    console.log(`removed ${t.name}`);
  }
  rmSync(file, { force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, arg] = process.argv.slice(2);
  const di = process.argv.indexOf('--dir');
  const run = { start: () => start(arg, di > 0 ? process.argv[di + 1] : undefined), status: () => status(arg), merge: () => merge(arg), clean: async () => clean(arg) }[cmd];
  if (!run) { console.error('usage: parallel.mjs start|status|merge|clean <tasks.json|state.json>'); process.exit(1); }
  run().catch((e) => { console.error(`parallel: ${e.message}`); process.exit(1); });
}
