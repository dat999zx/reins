#!/usr/bin/env node
// Runs several tasks at once, each in its own git worktree and its own Reins session, then merges them in order.
//   node scripts/parallel.mjs start tasks.json [--dir <folder for the worktrees>]
//   node scripts/parallel.mjs status <state.json>
//   node scripts/parallel.mjs merge  <state.json>      commits every finished task, merges in order, stops on the first conflict, then builds and runs the tests
//   node scripts/parallel.mjs clean  <state.json>      removes worktrees and branches once every task is merged
//   node scripts/parallel.mjs run <tasks.json|state.json> [--dir <folder>] [--approve fence] [--max-minutes <n>]   start, wait, merge, gate, clean; prints a report
//   run exit codes: 0 all merged, gate passed, cleaned; 1 error; 3 a card waited a minute; 4 gate failed; 5 --max-minutes reached; 6 a task not merged (nothing cleaned)
// tasks.json: { "title": "login work", "capUsd": 5, "approve": "fence", "tasks": [{ "name": "login", "playbook": "plans/login.reins.md", "model": "claude-haiku-5-5" }], "copy": ["docs/spec.md"] }
//   model and effort are optional per task; omitted, the provider default. A name Reins does not list refuses the whole start, after the worktrees are made: clean removes them.
//   approve "fence": safe-shaped requests are answered yes (auto: fence); git writes, installs, network, deletes and anything else stay cards. Not a sandbox: a test run executes code the agent wrote.
//   title and capUsd are optional. start registers the tasks as one run: the app shows them as one group with Stop all, Resume all and the cap. clean forgets the group.
// Needs a running `reins serve` (its port and token are read from ~/.reins/serve.lock). Each session asks its own trust questions in the app: answer them there.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** The POST /api/parallel body: one run for all tasks. capUsd only when the spec gives one. approve: "fence" only when the tasks file or --approve gives it.
 *  Each task item: { name: string; dir: string; model?: string; effort?: string }. model and effort only when the task names them. */
export function registerBody(spec, repo, runId, tasks) {
  return { title: spec.title ?? `parallel ${runId}`, repo, ...(spec.capUsd === undefined ? {} : { capUsd: spec.capUsd }), ...(spec.approve === undefined ? {} : { approve: spec.approve }), tasks: tasks.map((t) => ({ name: t.name, dir: t.dir, ...(t.model === undefined ? {} : { model: t.model }), ...(t.effort === undefined ? {} : { effort: t.effort }) })) };
}

const serverOrNone = () => { try { return server(); } catch { return undefined; } };

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

const sh = (cmd, cwd, show = false) => new Promise((ok, no) => spawn(cmd, { cwd, shell: true, stdio: show ? 'inherit' : 'ignore' }).on('exit', (c) => (c === 0 ? ok() : no(new Error(`${cmd} failed (${c}) in ${cwd}`)))));

/** Start/end (ms timestamps), end type and duration from a session log: the first row starts it, the first run_finished or run_stopped row ends it. Unset while running. */
export function timing(rows) {
  const r = rows.find((x) => x.type === 'run_finished' || x.type === 'run_stopped');
  const start = rows[0]?.ts;
  return { start, end: r?.ts, type: r?.type, ms: r && start !== undefined ? r.ts - start : undefined };
}

const clock = (ts) => (ts === undefined ? '-' : new Date(ts).toISOString().replace('T', ' ').slice(0, 19));
const took = (ms) => (ms === undefined ? '-' : `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`);
const span = (t) => `started ${clock(t.start)}, ended ${clock(t.end)}, took ${took(t.ms)}`;

async function ended(api, t) {
  const { rows } = await api('GET', `/api/sessions/${t.sessionId}/log?after=0`);
  return timing(rows);
}

async function start(file, dir, approve) {
  const repo = git(process.cwd(), 'rev-parse', '--show-toplevel');
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  spec.approve ??= approve;
  if (spec.approve !== undefined && spec.approve !== 'fence') throw new Error('approve must be "fence".');
  const base = preflight(repo);
  const runId = Date.now().toString(36);
  const root = resolve(dir ?? join(repo, '..', '.reins-par'));
  const startedAt = Date.now();
  const tasks = addWorktrees(repo, runId, root, spec.tasks, spec.copy);
  const state = join(root, runId, 'state.json');
  let parallelId;
  const save = () => writeFileSync(state, JSON.stringify({ repo, ...base, runId, startedAt, parallelId, tasks }, null, 2));
  save();
  console.log(`parallel: ${tasks.length} worktrees under ${join(root, runId)}; installing (npm ci + build) in parallel`);
  // A worktree must NOT share node_modules with the main checkout: @reins/core would resolve to main's copy for typecheck, server build and app bundle.
  await Promise.all(tasks.map((t) => sh('npm ci && npm run build', t.dir)));
  const api = server();
  const reg = await api('POST', '/api/parallel', registerBody(spec, repo, runId, tasks));
  parallelId = reg.id;
  for (const t of tasks) {
    t.sessionId = reg.tasks.find((r) => r.name === t.name).sessionId;
    if (t.playbook) await api('POST', `/api/sessions/${t.sessionId}/run`, { path: t.playbook });
    else await api('POST', `/api/sessions/${t.sessionId}/message`, { text: t.prompt });
    save();
    console.log(`  ${t.name}: session ${t.sessionId} started`);
  }
  console.log(spec.approve === 'fence'
    ? `\nApprovals are automatic for safe requests (auto: fence); anything else waits as a card in the app. State: ${state}`
    : `\nAnswer the trust questions in the app (one set per session). State: ${state}`);
  return state;
}

async function status(file) {
  const s = JSON.parse(readFileSync(file, 'utf8')), api = server();
  for (const t of s.tasks) {
    const e = await ended(api, t);
    console.log(`${t.name.padEnd(24)} ${e.type ?? 'running'}\n  ${span(e)}`);
  }
}

/** Returns { merged, notMerged: [{ name, why }], conflict, gate: 'pass' | 'fail' | 'not run' }. why: run_stopped, still running, no changes, conflict, after conflict. */
async function merge(file, api = server()) {
  const s = JSON.parse(readFileSync(file, 'utf8'));
  const ready = [], notMerged = [];
  for (const t of s.tasks) {
    const e = await ended(api, t);
    if (e.type !== 'run_finished') { console.log(`skip ${t.name}: ${e.type ?? 'still running'}\n  ${span(e)}`); notMerged.push({ name: t.name, why: e.type ?? 'still running' }); continue; }
    console.log(`time ${t.name}: ${span(e)}`);
    const files = commitAll(t);
    console.log(`commit ${t.name}: ${files.length} file(s)${files.length ? `\n  ${files.join('\n  ')}` : ''}`);
    if (files.length) ready.push(t); else notMerged.push({ name: t.name, why: 'no changes' });
  }
  const r = mergeInOrder(s.repo, ready, s);
  console.log(`merged: ${r.merged.join(', ') || 'none'}`);
  for (const t of ready) if (!r.merged.includes(t.name)) notMerged.push({ name: t.name, why: t.name === r.conflict?.task ? 'conflict' : 'after conflict' });
  if (r.conflict) { console.log(`CONFLICT in ${r.conflict.task}: ${r.conflict.files.join(', ') || r.conflict.why}\nThe merge was aborted; resolve by hand, then run merge again.`); process.exitCode = 2; return { merged: r.merged, notMerged, conflict: r.conflict, gate: 'not run' }; }
  let gate = 'pass';
  try {
    await sh('npm run build', s.repo, true);
    console.log('gate: node scripts/test-affected.mjs --all --jobs 4');
    await sh('node scripts/test-affected.mjs --all --jobs 4', s.repo, true); // shown: a failed gate must say which file failed
  } catch (e) { console.log(`gate failed: ${e.message}`); process.exitCode = 1; gate = 'fail'; }
  return { merged: r.merged, notMerged, conflict: undefined, gate };
}

/** Question rows with no later answer or question_closed of their id. */
export function openQuestions(rows) {
  const open = new Map();
  for (const r of rows) {
    if (r.type === 'question') open.set(r.data?.id, r);
    else if (r.type === 'answer' || r.type === 'question_closed') open.delete(r.data?.questionId);
  }
  return [...open.values()];
}

/** The open questions that have waited `ms` or more. */
export const stuck = (rows, now, ms = 60000) => openQuestions(rows).filter((q) => now - q.ts >= ms);

/** The turn costs of a log; `unknown` when a turn has no number. Same sum as the rail. */
function costOf(rows) {
  let usd = 0, unknown = false;
  for (const r of rows) {
    if (r.type !== 'turn_ended') continue;
    if (typeof r.data?.cost === 'number') usd += r.data.cost;
    if (r.data?.unknown === true || typeof r.data?.cost !== 'number') unknown = true;
  }
  return { usd, unknown };
}
const money = (c) => `${c.unknown ? 'at least ' : ''}$${c.usd.toFixed(2)}`;

/** One report line: name, model, minutes, cost, state, merged, automatic and other answers. */
export function taskLine(name, rows, merged) {
  const t = timing(rows);
  const state = t.type ?? (openQuestions(rows).length ? 'open card' : 'running');
  const answers = rows.filter((r) => r.type === 'answer');
  const auto = answers.filter((r) => r.data?.by === 'fence').length;
  const mins = rows.length ? `${Math.round(((t.end ?? rows.at(-1).ts) - t.start) / 60000)}m` : '-';
  return `${name}  ${rows.find((r) => r.type === 'session_created')?.data?.model ?? '-'}  ${mins}  ${money(costOf(rows))}  ${state}  ${merged ? 'merged' : 'not merged'}  auto ${auto} other ${answers.length - auto}`;
}

/** The report: a line per task, the totals, the not-a-sandbox line. rowsByTask is keyed by task name. */
export function reportLines(state, rowsByTask, mergeResult, now) {
  const all = state.tasks.map((t) => rowsByTask[t.name] ?? []);
  const total = costOf(all.flat());
  const wall = state.startedAt === undefined ? '-' : `${Math.round((now - state.startedAt) / 60000)}m`;
  return [
    ...state.tasks.map((t, i) => taskLine(t.name, all[i], !!mergeResult?.merged.includes(t.name))),
    `gate: ${mergeResult?.gate ?? 'not run'}    wall: ${wall}    cost: ${money(total)}`,
    'Automatic answers follow the shape of a request, not what the code it runs does: a test or lint run executes code the agent wrote. Not a sandbox.',
  ];
}

/** Start (or take a state file), wait, merge, gate and clean. Returns the exit code: 0 done, 3 a card waits, 4 gate failed, 5 --max-minutes, 6 a task not merged. */
export async function run(arg, o = {}) {
  const { dir, approve, maxMinutes = 120, everyMs = 10000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = o;
  const spec = JSON.parse(readFileSync(arg, 'utf8'));
  const isState = spec.runId && spec.tasks?.every((t) => t.sessionId);
  if (!isState) {
    const bad = spec.tasks?.find((t) => !t.playbook);
    if (bad) throw new Error(`Task "${bad.name}" has no playbook; run needs one per task.`);
  }
  const file = isState ? arg : await start(arg, dir, approve);
  const api = o.api ?? server();
  const s = JSON.parse(readFileSync(file, 'utf8'));
  const t0 = now(), rowsBy = Object.fromEntries(s.tasks.map((t) => [t.name, []]));
  const report = (m) => console.log(reportLines(s, rowsBy, m, now()).join('\n'));
  for (;;) {
    for (const t of s.tasks) {
      const rows = rowsBy[t.name];
      if (timing(rows).type) continue;
      const last = rows.reduce((n, r) => Math.max(n, r.seq), 0);
      rows.push(...(await api('GET', `/api/sessions/${t.sessionId}/log?after=${last}`)).rows);
    }
    if (s.tasks.every((t) => timing(rowsBy[t.name]).type)) break;
    const waiting = s.tasks.flatMap((t) => (timing(rowsBy[t.name]).type ? [] : stuck(rowsBy[t.name], now()).map((q) => [t, q])));
    if (waiting.length) {
      const cut = (v, n) => (typeof v === 'string' ? v : JSON.stringify(v ?? '')).slice(0, n);
      for (const [t, q] of waiting) console.log(`${t.name}: ${q.data.kind}: ${cut(q.data.prompt, 300)}\n  ${cut(q.data.detail, 600)}`);
      console.log(`Answer it in the app, then: node scripts/parallel.mjs run ${file}`);
      report();
      return 3;
    }
    if (now() - t0 >= maxMinutes * 60000) {
      for (const t of s.tasks) console.log(taskLine(t.name, rowsBy[t.name], false));
      report();
      return 5;
    }
    await sleep(everyMs);
  }
  const m = await merge(file, api);
  if (m.gate === 'fail') { report(m); return 4; }
  if (m.notMerged.length) {
    for (const n of m.notMerged) console.log(`not merged: ${n.name} (${n.why})`);
    report(m);
    return 6;
  }
  for (const t of s.tasks) {
    const from = join(t.dir, 'docs', 'plan');
    if (!existsSync(from)) continue;
    for (const f of readdirSync(from).filter((x) => x.endsWith('-report.md'))) {
      mkdirSync(join(s.repo, 'docs', 'plan', 'reports'), { recursive: true });
      copyFileSync(join(from, f), join(s.repo, 'docs', 'plan', 'reports', f));
    }
  }
  await clean(file, api);
  report(m);
  return 0;
}

/** Closes every session (a live agent holds its folder on Windows), forgets the group, then removes the merged worktrees. `api` is server(), or undefined when Reins is not running. */
export async function clean(file, api) {
  const s = JSON.parse(readFileSync(file, 'utf8'));
  let down = !api, forgot = !s.parallelId, unfinished = false;
  const ok404 = (e) => / 404 /.test(e.message);
  if (!down) {
    for (const t of s.tasks.filter((x) => x.sessionId)) {
      try { await api('POST', `/api/sessions/${t.sessionId}/close`, {}); } catch (e) { if (!ok404(e)) { down = true; break; } }
    }
  }
  const isMerged = (t) => git(s.repo, 'branch', '--merged', 'HEAD', '--list', t.branch) !== '';
  const dirtyOf = (t) => { try { return git(t.dir, 'status', '--porcelain'); } catch { return ''; } }; // folder already gone: nothing to lose
  // a dirty task keeps the group in the app: the owner still has work to finish there
  if (!down && s.parallelId && !s.tasks.some((t) => isMerged(t) && dirtyOf(t))) {
    try { await api('POST', `/api/parallel/${s.parallelId}/forget`); forgot = true; } catch (e) { if (ok404(e)) forgot = true; else down = true; }
  }
  if (down && s.parallelId) console.log('The group stays in the app until you run clean again with Reins running.');
  for (const t of s.tasks) {
    if (!isMerged(t)) { console.log(`keep ${t.name}: ${t.branch} is not merged`); continue; }
    if (dirtyOf(t)) { console.log(`keep ${t.name}: ${t.dir} has uncommitted changes; finish or stop it, merge, then clean`); unfinished = true; continue; }
    try { git(s.repo, 'worktree', 'remove', '--force', t.dir); } catch (e) {
      if (!/not a working tree/.test(String(e.stderr))) { console.log(`keep ${t.name}: ${t.dir} is still in use; run clean again`); unfinished = true; continue; } // already gone: still drop the branch
    }
    git(s.repo, 'branch', '-d', t.branch);
    console.log(`removed ${t.name}`);
  }
  if (forgot && !unfinished) rmSync(file, { force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, arg] = process.argv.slice(2);
  const flag = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const mm = flag('--max-minutes');
  const go = { start: () => start(arg, flag('--dir'), flag('--approve')), status: () => status(arg), merge: () => merge(arg), clean: () => clean(arg, serverOrNone()),
    run: async () => { process.exitCode = await run(arg, { dir: flag('--dir'), approve: flag('--approve'), ...(mm === undefined ? {} : { maxMinutes: Number(mm) }) }); } }[cmd];
  if (!go) { console.error('usage: parallel.mjs start|status|merge|clean|run <tasks.json|state.json>'); process.exit(1); }
  go().catch((e) => { console.error(`parallel: ${e.message}`); process.exit(1); });
}
