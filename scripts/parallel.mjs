#!/usr/bin/env node
// A client of `reins serve`: the server makes the worktrees, runs the sessions, merges, runs the gate and cleans. This script starts a run, waits, and prints.
//   node scripts/parallel.mjs start tasks.json [--dir <folder for the worktrees>] [--approve fence] [--yes]   prints a run id
//   node scripts/parallel.mjs status <id>
//   node scripts/parallel.mjs merge  <id>      merges every finished task in order, stops on the first conflict, then runs the gate
//   node scripts/parallel.mjs clean  <id>      closes the sessions, removes the merged worktrees and branches; needs a running server
//   node scripts/parallel.mjs run <tasks.json|id> [--dir <folder>] [--approve fence] [--yes] [--max-minutes <n>]   start, wait, merge, gate, clean; prints a report
//   run exit codes: 0 all merged, gate passed, cleaned; 1 error; 3 a card waited a minute; 4 gate failed; 5 --max-minutes reached; 6 a task not merged (nothing cleaned)
// tasks.json: { "title": "login work", "capUsd": 5, "approve": "fence", "install": "npm ci && npm run build", "gate": "node scripts/test-affected.mjs --all --jobs 4", "gateRetry": "node scripts/test-affected.mjs --jobs 2", "reports": "docs/plan", "tasks": [{ "name": "login", "playbook": "plans/login.reins.md", "model": "claude-haiku-5-5" }], "copy": ["docs/spec.md"] }
//   install, gate, gateRetry and reports are optional: absent means skip. The values above are this repo's.
//   Every task needs a playbook. model and effort are optional per task; omitted, the provider default.
//   start and run of a tasks file print install, gate, gateRetry and approve and ask y first; --yes skips the question. No terminal and no --yes: refused.
//   approve "fence": safe-shaped requests are answered yes (auto: fence); git writes, installs, network, deletes and anything else stay cards. Not a sandbox: a test run executes code the agent wrote.
//   title and capUsd are optional. The app shows the tasks as one group with Stop all, Resume all and the cap.
// Needs a running `reins serve` (its port and token are read from ~/.reins/serve.lock). Each session asks its own trust questions in the app: answer them there.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

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

/** The run's row, or a throw when the server has none of that id. */
export const runOf = async (api, id) => {
  const r = (await api('GET', '/api/parallel')).runs.find((x) => x.id === id);
  if (!r) throw new Error(`No run ${id}.`);
  return r;
};

/** Polls until the run's phase is one of `phases`; returns the row. Callers list `failed` and `interrupted` too. */
export async function waitPhase(api, id, phases, { everyMs = 10000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (;;) {
    const r = await runOf(api, id);
    if (!r.phase) throw new Error(`Run ${id} was not started by Reins.`);
    if (phases.includes(r.phase)) return r;
    await sleep(everyMs);
  }
}

/** The commands a tasks file will run, one line each. */
export const showPlan = (spec) => [
  `install: ${spec.install ?? 'none'}`,
  `gate: ${spec.gate ?? 'none'}`,
  `gateRetry: ${spec.gateRetry ?? 'same command'}`,
  `approve: ${spec.approve === 'fence' ? 'fence' : 'every request is a card'}`,
];

async function askStdin() {
  if (!process.stdin.isTTY) throw new Error('This tasks file runs the commands above. Run it in a terminal, or pass --yes.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question('Run these commands? [y/N] '); } finally { rl.close(); }
}

/** Prints the plan, then goes on when `yes` or the typed line is y or yes; otherwise throws. */
export async function consent(spec, { yes, ask = askStdin } = {}) {
  console.log(showPlan(spec).join('\n'));
  if (yes) return;
  const a = String(await ask()).trim().toLowerCase();
  if (a !== 'y' && a !== 'yes') throw new Error('Not started.');
}

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

/** Reads the tasks file, shows the commands, asks, starts the run on the server and waits for setup. Returns the run id. */
export async function start(file, { dir, approve, yes, api = server(), ask, everyMs, sleep } = {}) {
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  if (spec.runId) throw new Error(`${file} is a state file from before M8; finish it with the old script.`);
  if (approve !== undefined) spec.approve ??= approve;
  await consent(spec, { yes, ask });
  const { id } = await api('POST', '/api/parallel/start', { cwd: process.cwd(), spec, ...(dir === undefined ? {} : { dir: resolve(dir) }) });
  console.log(`run ${id}`);
  const s = await waitPhase(api, id, ['running', 'failed', 'interrupted'], { everyMs, sleep });
  if (s.phase !== 'running') throw new Error(s.job?.words || `Setup ${s.phase}.`);
  return id;
}

export async function status(id, api = server()) {
  const s = await runOf(api, id);
  console.log(`phase: ${s.phase ?? 'none'}`);
  for (const t of s.tasks) {
    const e = await ended(api, t);
    console.log(`${t.name.padEnd(24)} ${e.type ?? 'running'}\n  ${span(e)}`);
  }
}

/** Asks the server to merge, waits, prints. Returns { merged, notMerged, conflict, gate }. Throws `words` for a failure that is neither a conflict nor a failed gate. Sets no exit code. */
async function mergeStep(id, api, o) {
  await api('POST', `/api/parallel/${id}/merge`, {});
  const s = await waitPhase(api, id, ['done', 'failed', 'interrupted'], o);
  const j = s.job;
  console.log(`merged: ${j.merged.join(', ') || 'none'}`);
  if (j.conflict) console.log(`CONFLICT in ${j.conflict.task}: ${j.conflict.files.join(', ') || j.conflict.why}\nThe merge was aborted; resolve by hand, then run merge again.`);
  else if (j.gateResult === 'fail') console.log(`gate failed:\n${j.words}`);
  else if (s.phase !== 'done') throw new Error(j.words || `The merge ${s.phase}.`);
  return { merged: j.merged, notMerged: j.notMerged, conflict: j.conflict, gate: j.gateResult };
}

/** The merge command: exit code 2 on a conflict, 1 on a failed gate. */
export async function merge(id, api = server(), o = {}) {
  const m = await mergeStep(id, api, o);
  if (m.conflict) process.exitCode = 2;
  else if (m.gate === 'fail') process.exitCode = 1;
  return m;
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

/** Start (or take a run id), wait, merge, gate and clean. Returns the exit code: 0 done, 3 a card waits, 4 gate failed, 5 --max-minutes, 6 a task not merged. */
export async function run(arg, o = {}) {
  const { dir, approve, yes, ask, maxMinutes = 120, everyMs = 10000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = o;
  const api = o.api ?? server();
  const wait = { everyMs, sleep };
  const id = /^[0-9a-f]{12}$/.test(arg) ? arg : await start(arg, { dir, approve, yes, api, ask, everyMs, sleep });
  let s = await runOf(api, id);
  if (s.phase === 'setup') {
    s = await waitPhase(api, id, ['running', 'failed', 'interrupted'], wait);
    if (!s.tasks.length) throw new Error(s.job?.words || `Setup ${s.phase}.`);
  } else if (s.phase === 'merging' || s.phase === 'gating') s = await waitPhase(api, id, ['done', 'failed', 'interrupted'], wait);
  const t0 = now(), rowsBy = Object.fromEntries(s.tasks.map((t) => [t.name, []]));
  const state = { tasks: s.tasks, startedAt: s.createdAt };
  const report = (m) => console.log(reportLines(state, rowsBy, m, now()).join('\n'));
  for (;;) {
    for (const t of s.tasks) {
      const rows = rowsBy[t.name];
      const last = rows.reduce((n, r) => Math.max(n, r.seq), 0);
      rows.push(...(await api('GET', `/api/sessions/${t.sessionId}/log?after=${last}`)).rows);
    }
    if ((await runOf(api, id)).ended) break;
    const waiting = s.tasks.flatMap((t) => stuck(rowsBy[t.name], now()).map((q) => [t, q]));
    if (waiting.length) {
      const cut = (v, n) => (typeof v === 'string' ? v : JSON.stringify(v ?? '')).slice(0, n);
      for (const [t, q] of waiting) console.log(`${t.name}: ${q.data.kind}: ${cut(q.data.prompt, 300)}\n  ${cut(q.data.detail, 600)}`);
      console.log(`Answer it in the app, then: node scripts/parallel.mjs run ${id}`);
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
  const m = s.phase === 'done' ? { merged: s.job.merged, notMerged: s.job.notMerged, conflict: undefined, gate: s.job.gateResult } : await mergeStep(id, api, wait);
  if (m.gate === 'fail') { report(m); return 4; }
  if (m.notMerged.length) {
    for (const n of m.notMerged) console.log(`not merged: ${n.name} (${n.why})`);
    report(m);
    return 6;
  }
  await clean(id, api);
  report(m);
  return 0;
}

/** The server closes every session (a live agent holds its folder on Windows), then removes the merged worktrees. Prints what it removed and kept. */
export async function clean(id, api = server()) {
  const r = await api('POST', `/api/parallel/${id}/clean`, {});
  for (const n of r.removed) console.log(`removed ${n}`);
  for (const k of r.kept) console.log(`keep ${k.name}: ${k.why}`);
  if (!r.forgotten) console.log('The group stays in the app until you run clean again.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, arg] = process.argv.slice(2);
  const flag = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const mm = flag('--max-minutes'), yes = process.argv.includes('--yes');
  const go = { start: () => start(arg, { dir: flag('--dir'), approve: flag('--approve'), yes }), status: () => status(arg), merge: () => merge(arg), clean: () => clean(arg),
    run: async () => { process.exitCode = await run(arg, { dir: flag('--dir'), approve: flag('--approve'), yes, ...(mm === undefined ? {} : { maxMinutes: Number(mm) }) }); } }[cmd];
  if (!go) { console.error('usage: parallel.mjs start|status|merge|clean|run <tasks.json|id>'); process.exit(1); }
  go().catch((e) => { console.error(`parallel: ${e.message}`); process.exit(1); });
}
