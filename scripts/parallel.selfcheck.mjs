// node scripts/parallel.selfcheck.mjs: the pure helpers of parallel.mjs, and its commands against a fake api (no server, no git). Exits non-zero on a wrong answer.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clean, consent, merge, openQuestions, reportLines, run, showPlan, stuck, taskLine, timing, waitPhase } from './parallel.mjs';

const rows = [{ type: 'user', ts: 1000 }, { type: 'tool', ts: 2000 }, { type: 'run_finished', ts: 91000 }, { type: 'run_stopped', ts: 99000 }];
assert.deepEqual(timing(rows), { start: 1000, end: 91000, type: 'run_finished', ms: 90000 }, 'the first end row wins');
assert.deepEqual(timing(rows.slice(0, 2)), { start: 1000, end: undefined, type: undefined, ms: undefined }, 'a running task has no end');

const qrow = (seq, id, ts = 0) => ({ seq, ts, type: 'question', data: { id, kind: 'tool', prompt: `p${id}`, detail: `d${id}` } });
const arow = (seq, id, by) => ({ seq, ts: 0, type: 'answer', data: { questionId: id, answer: 'y', ...(by ? { by } : {}) } });
const qs = [qrow(1, 'q1'), qrow(2, 'q2'), arow(3, 'q1'), qrow(4, 'q3'), { seq: 5, ts: 0, type: 'question_closed', data: { questionId: 'q3' } }];
assert.deepEqual(openQuestions(qs).map((r) => r.data.id), ['q2'], 'answered and closed questions are not open');
assert.equal(stuck([qrow(1, 'q1', 1000)], 60999).length, 0, 'a card under 60 s is not stuck');
assert.equal(stuck([qrow(1, 'q1', 1000)], 61000).length, 1, 'a card of 60 s is stuck');

const M = 60000;
const fake = [
  { seq: 1, ts: 0, type: 'session_created', data: { model: 'claude-sonnet-5-5' } },
  { seq: 2, ts: M, type: 'turn_ended', data: { cost: 0.25 } },
  { seq: 3, ts: 2 * M, type: 'turn_ended', data: { cost: 0.5 } },
  arow(4, 'q1', 'fence'), arow(5, 'q2'),
  { seq: 6, ts: 9 * M, type: 'run_finished', data: {} },
];
const line = taskLine('A', fake, true);
for (const w of ['claude-sonnet-5-5', '$0.75', '9m', 'auto 1 other 1', ' merged']) assert.ok(line.includes(w), `task line has ${w}: ${line}`);
const rep = reportLines({ tasks: [{ name: 'A' }] }, { A: fake }, undefined, 5 * M);
assert.ok(rep.some((l) => l.includes('wall: -')), 'no startedAt: wall is -');
assert.ok(rep.some((l) => /not a sandbox|executes code the agent wrote/.test(l)), 'the sandbox line is always printed');

assert.deepEqual(showPlan({ install: 'npm ci', gate: 'npm test', approve: 'fence' }), ['install: npm ci', 'gate: npm test', 'gateRetry: same command', 'approve: fence'], 'the plan lines');
assert.deepEqual(showPlan({ gateRetry: 'npm run t2' }), ['install: none', 'gate: none', 'gateRetry: npm run t2', 'approve: every request is a card'], 'absent means none');

const cap = async (f) => { const out = [], o = console.log; console.log = (...a) => out.push(a.join(' ')); try { return [await f(), out.join('\n')]; } finally { console.log = o; } };
const RID = 'aaaaaaaaaaaa';
const jobOf = (j = {}) => ({ repo: 'D:/repo', branch: 'main', head: 'h', folder: 'D:/par/x', tasks: [], words: '', merged: [], notMerged: [], gateResult: 'not run', ...j });
const TASKS = [{ name: 'A', sessionId: 'sa' }, { name: 'B', sessionId: 'sb' }];
const rowOf = (phase, j, tasks = TASKS) => ({ id: RID, title: 't', createdAt: 0, tasks, phase, job: jobOf(j) });
const over = [{ seq: 1, ts: 0, type: 'session_created', data: {} }, { seq: 2, ts: M, type: 'run_finished', data: {} }];
// GET /api/parallel returns `row`, then the next of `queue` each call; a merge POST moves the row to `afterMerge`.
const mkApi = ({ row, queue = [], afterMerge, logs = { sa: over, sb: over } }) => {
  const st = { row, events: [], body: undefined, gets: [] };
  st.api = async (method, path, body) => {
    const m = path.match(/sessions\/(s\w)\/log\?after=(\d+)/);
    if (m) { st.gets.push(`${m[1]} after=${m[2]}`); return { rows: logs[m[1]].filter((r) => r.seq > Number(m[2])) }; }
    if (method === 'GET' && path === '/api/parallel') { st.events.push('GET runs'); const r = st.row; if (queue.length) st.row = queue.shift(); return { runs: [r] }; }
    if (method === 'POST' && path === '/api/parallel/start') { st.events.push('POST start'); st.body = body; return { id: RID }; }
    if (method === 'POST' && path === `/api/parallel/${RID}/merge`) { st.events.push('POST merge'); st.row = afterMerge; return { phase: 'merging' }; }
    if (method === 'POST' && path === `/api/parallel/${RID}/clean`) { st.events.push('POST clean'); return { removed: ['A', 'B'], kept: [], forgotten: true }; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return st;
};
const rdir = mkdtempSync(join(tmpdir(), 'par-run-'));
const sleep = async () => {};
try {
  let clock = 100 * M;
  const go = (st, o = {}) => cap(() => run(RID, { api: st.api, now: () => clock, sleep, ...o }));
  // a card 61 s old, no end row: exit 3, the run line names the id, nothing merged
  let st = mkApi({ row: rowOf('running'), logs: { sa: [qrow(1, 'q1', clock - 61000)], sb: [] } });
  let [code, text] = await go(st);
  assert.equal(code, 3, 'a stuck card exits 3');
  assert.ok(text.includes('A') && text.includes('pq1'), 'the card is named');
  assert.ok(text.includes(`node scripts/parallel.mjs run ${RID}`), 'the run line carries the id');
  assert.ok(!st.events.includes('POST merge'), 'no merge');
  // two polls: the second asks after the highest seq of the first answer
  st = mkApi({ row: rowOf('running'), logs: { sa: [{ seq: 1, ts: clock, type: 'session_created', data: {} }, qrow(7, 'q1', clock)], sb: [] } });
  [code] = await go(st, { sleep: async () => { clock += 61000; } });
  assert.equal(code, 3);
  assert.deepEqual(st.gets.filter((g) => g.startsWith('sa')), ['sa after=0', 'sa after=7'], 'the second poll uses the last seq seen');
  // no card, no end row: --max-minutes
  clock = 0;
  st = mkApi({ row: rowOf('running'), logs: { sa: [], sb: [] } });
  [code] = await cap(() => run(RID, { api: st.api, maxMinutes: 0.001, now: () => (clock += M), sleep }));
  assert.equal(code, 5, 'max minutes exits 5');
  clock = 100 * M;

  // done, gate passed: 0, clean after the merge, the report reads createdAt
  st = mkApi({ row: rowOf('running'), afterMerge: rowOf('done', { merged: ['A', 'B'], gateResult: 'pass' }) });
  [code, text] = await go(st);
  assert.equal(code, 0);
  assert.deepEqual(st.events.filter((e) => e.startsWith('POST')), ['POST merge', 'POST clean'], 'merge, then clean');
  assert.ok(text.includes('gate: pass') && text.includes('wall: 100m'), `the report: ${text}`);
  // failed, gate failed: 4, no clean, the words are printed
  st = mkApi({ row: rowOf('running'), afterMerge: rowOf('failed', { merged: ['A', 'B'], gateResult: 'fail', words: 'test x broke' }) });
  [code, text] = await go(st);
  assert.equal(code, 4);
  assert.ok(!st.events.includes('POST clean') && text.includes('test x broke'), 'no clean, words printed');
  // done with a task not merged: 6, no clean
  st = mkApi({ row: rowOf('running'), afterMerge: rowOf('done', { merged: ['A'], notMerged: [{ name: 'B', why: 'no changes' }], gateResult: 'pass' }) });
  [code, text] = await go(st);
  assert.equal(code, 6);
  assert.ok(!st.events.includes('POST clean') && text.includes('not merged: B (no changes)'), 'no clean, B named');
  // a conflict is a task not merged too: 6
  st = mkApi({ row: rowOf('running'), afterMerge: rowOf('failed', { merged: ['A'], notMerged: [{ name: 'B', why: 'conflict' }], conflict: { task: 'B', files: ['f.js'], why: '' } }) });
  [code, text] = await go(st);
  assert.equal(code, 6);
  assert.ok(text.includes('CONFLICT in B: f.js') && !st.events.includes('POST clean'), 'conflict named, no clean');
  // failed or interrupted with no conflict and no gate failure: rejects with the words, no clean
  for (const phase of ['failed', 'interrupted']) {
    st = mkApi({ row: rowOf('running'), afterMerge: rowOf(phase, { words: 'The main tree changed while merging:\n f.js' }) });
    await assert.rejects(go(st), /The main tree changed while merging/);
    assert.ok(!st.events.includes('POST clean'), `no clean after ${phase}`);
  }
  // rerun on a row already done: no merge POST, clean, 0, the gate line reads pass
  st = mkApi({ row: rowOf('done', { merged: ['A', 'B'], gateResult: 'pass' }) });
  [code, text] = await go(st);
  assert.equal(code, 0);
  assert.deepEqual(st.events.filter((e) => e.startsWith('POST')), ['POST clean'], 'no merge POST');
  assert.ok(text.includes('gate: pass'), 'gate: pass from the job');
  // rerun on a row in gating: waits for it to leave before any POST
  st = mkApi({ row: rowOf('gating'), queue: [rowOf('gating'), rowOf('failed', { gateResult: 'fail', words: 'w' })], afterMerge: rowOf('failed', { gateResult: 'fail', words: 'w' }) });
  [code] = await go(st);
  assert.equal(code, 4);
  assert.ok(st.events.indexOf('POST merge') >= 3 && st.events.slice(0, 3).every((e) => e === 'GET runs'), 'three reads before the merge POST');
  // rerun on a row in setup: waits for running first
  st = mkApi({ row: rowOf('setup', {}, []), queue: [rowOf('setup', {}, []), rowOf('running')], afterMerge: rowOf('done', { merged: ['A', 'B'], gateResult: 'pass' }) });
  [code] = await go(st);
  assert.equal(code, 0);
  assert.ok(st.events.indexOf('POST merge') >= 3, 'no POST until running');
  // waitPhase polls with the sleep it is given
  let slept = 0;
  st = mkApi({ row: rowOf('setup'), queue: [rowOf('setup'), rowOf('running')] });
  assert.equal((await waitPhase(st.api, RID, ['running'], { everyMs: 5, sleep: async (ms) => { slept += ms; } })).phase, 'running');
  assert.equal(slept, 10, 'it slept twice');

  // a tasks file: start POSTs { cwd, spec } with no dir key, a failed setup rejects with the words
  const file = join(rdir, 'tasks.json');
  const spec = { tasks: [{ name: 'A', playbook: 'p.md' }] };
  writeFileSync(file, JSON.stringify(spec));
  st = mkApi({ row: rowOf('failed', { words: 'setup broke' }, []) });
  await assert.rejects(cap(() => run(file, { api: st.api, yes: true, now: () => clock, sleep })), /setup broke/);
  assert.deepEqual(st.body, { cwd: process.cwd(), spec }, 'the POST body');
  assert.ok(!('dir' in st.body), 'no dir key when absent');
  st = mkApi({ row: rowOf('running'), afterMerge: rowOf('done', { merged: ['A', 'B'], gateResult: 'pass' }) });
  [code] = await cap(() => run(file, { api: st.api, yes: true, dir: 'x', now: () => clock, sleep }));
  assert.equal(code, 0);
  assert.equal(st.events[0], 'POST start');
  assert.ok(typeof st.body.dir === 'string' && st.body.dir !== 'x', 'dir is resolved');
  // consent: n stops before any POST, the plan was printed; --yes asks nothing
  writeFileSync(file, JSON.stringify({ ...spec, install: 'npm ci', gate: 'npm test' }));
  st = mkApi({ row: rowOf('running') });
  [, text] = await cap(async () => { await assert.rejects(run(file, { api: st.api, ask: async () => 'n', now: () => clock, sleep }), /Not started\./); });
  assert.ok(text.includes('install: npm ci') && text.includes('gate: npm test'), 'the plan is printed first');
  assert.equal(st.events.length, 0, 'no POST reached the api');
  await cap(() => consent({}, { yes: true, ask: async () => { throw new Error('asked'); } }));
  // an old state file is refused with no POST
  writeFileSync(file, JSON.stringify({ runId: 'r', tasks: [] }));
  st = mkApi({ row: rowOf('running') });
  await assert.rejects(cap(() => run(file, { api: st.api, yes: true })), /state file from before M8/);
  assert.equal(st.events.length, 0, 'no POST');

  // merge command: conflict exits 2; clean prints the kept and the group line
  const before = process.exitCode;
  st = mkApi({ row: rowOf('running'), afterMerge: rowOf('failed', { merged: ['A'], conflict: { task: 'B', files: ['f.js'], why: '' } }) });
  await cap(() => merge(RID, st.api, { sleep }));
  assert.equal(process.exitCode, 2, 'a conflict exits 2');
  process.exitCode = before;
  [, text] = await cap(() => clean(RID, async () => ({ removed: ['A'], kept: [{ name: 'B', why: 'not merged' }], forgotten: false })));
  assert.ok(text.includes('removed A') && text.includes('keep B: not merged') && text.includes('The group stays'), `clean output: ${text}`);
  console.log('parallel selfcheck: ok');
} finally {
  rmSync(rdir, { recursive: true, force: true });
}
