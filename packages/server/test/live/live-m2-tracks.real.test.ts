// Milestone M2, Task 25b: the orchestrator's live checks of tracks, against real providers (REINS_LIVE=1) or, in the normal suite, the scripted fake.
// A test-only block mod `split` is written into the temp home at run time and trusted like any user mod; its op starts two tracks that each run
// their own steps and joins them. Four rows: two engines, Stop with a tool approval open, a USD limit crossed with one re-share, and a restore
// after the server process was killed mid-split. A secret never leaves this file: evidence goes through `record`, which refuses a block with a key.
import { vi } from 'vitest';
// Without REINS_LIVE=1 the rows run against the fake (the harness would skip them): the dry version belongs to the normal suite.
vi.hoisted(() => { if (process.env.REINS_LIVE !== '1') process.env.REINS_LIVE_DRY = '1'; });
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CATALOG_DIR } from '../../src/engines.js';
import { hashFiles, readFolder } from '../../src/mods/loader.js';
import type { LogRow } from '../../src/store.js';
import { startFakeProvider } from '../fake-provider.js';
import { openQuestions, request } from '../http-helpers.js';
import {
  LONG, MODE, PROVIDERS, SHELL, allowAll, call, conversationLines, costOf, liveSuite, rawUsage, record, sameCost, sleep, startWorld, sweep, tokens,
  type Handler, type World,
} from './live-harness.js';

type Fake = Awaited<ReturnType<typeof startFakeProvider>>;
const MODEL = 'claude-haiku-5-5';
const REAL = MODE === 'real';
/** Row 4 on the claude CLI engine instead of the API (REINS_M2_ROW4=cli): for a machine with a CLI login and no API key. Real mode only; the rows say so. */
const CLI4 = REAL && process.env.REINS_M2_ROW4 === 'cli';
const ASSUMED = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const DIST_CLI = path.join(REPO, 'packages', 'server', 'dist', 'cli.js');
/** Real runs are written to the file of this milestone; dry runs have the harness's own file, so a rehearsal never reads as evidence. */
const EVIDENCE = REAL ? path.join(REPO, 'docs', 'plan', 'm2-real-checks.md') : undefined;

// ---- the test mod

const MOD_ID = 'split';
const manifest = (version: string) => ({
  reins: 1, id: MOD_ID, kind: 'block', version, label: 'Split', main: 'index.js', order: 140,
  provides: { kinds: ['split'], ops: ['SPLIT'], attrs: ['share'], events: ['split_started', 'split_done'] },
  view: { kind: 'split', fields: [], line: ['split'], manyNext: true },
});
// Starts a track at each `next` target (keyed by the step there) and parks; when every one ended it hands the results back and moves on.
const CODE = `export default function activate(api) {
  api.registerBlock({
    kind: 'split', attrs: ['share'], manyNext: true,
    compile(step, ctx) {
      const op = ctx.push({ op: 'SPLIT', step: step.id, targets: [], share: step.attrs.share === 'yes' });
      for (const l of step.links) if (l.kind === 'next') ctx.linkTo(l.to, (t) => { op.targets.push(t); });
    },
    ops: {
      SPLIT: {
        async exec(i, vm) {
          const results = vm.tracks.take(i.step);
          if (!results) {
            vm.tracks.start(i.step, i.targets.map((at) => ({ key: vm.program[at].step ?? i.step + '@' + at, at, title: 'Split ' + i.step, ...(i.share ? { share: true } : {}) })));
            vm.log('split_started', { step: i.step });
            return;
          }
          for (const r of results) vm.handBack('Result of ' + r.key + ': ' + r.text);
          vm.next();
          vm.log('split_done', { step: i.step });
        },
        next: (i, at) => [at + 1, ...i.targets],
        starts: (i) => i.targets,
      },
    },
  });
}
`;
/** Writes the mod into `<dir>/mods/split` and trusts it the way the trust file does (the hash of its files). */
function installSplit(dir: string, version = '1.0.0') {
  const folder = path.join(dir, 'mods', MOD_ID);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'mod.json'), JSON.stringify(manifest(version), null, 2));
  fs.writeFileSync(path.join(folder, 'index.js'), CODE);
  const file = path.join(dir, 'mod-trust.json');
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  all[MOD_ID] = hashFiles(readFolder(folder, MOD_ID));
  fs.writeFileSync(file, JSON.stringify(all));
}

const HEAD = (name: string, usd: number) => `---\nreins: 1\nname: ${name}\nbudget: { turns: 40, minutes: 15, usd: ${usd} }\nalways: []\n---\n\n`;
const phase = (id: string, text: string) => `## phase ${id}\nid: ${id}\n> ${text}\n\n`;
const END = '## end\n\n';

// ---- processes

interface Proc { pid: number; ppid: number; name: string; claude: boolean }
/** Every process now: id, parent, name, and whether its name or command line says claude. The command line is read here and never kept. */
function processes(): Proc[] {
  if (process.platform !== 'win32') {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,args=']).toString().split('\n').filter(Boolean);
    return out.map((l) => { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)!; return { pid: Number(m[1]), ppid: Number(m[2]), name: m[3]!.split(' ')[0]!, claude: /claude/i.test(m[3]!) }; });
  }
  // The word is built in two pieces so that this very command line does not match it; `self` marks the query's own process.
  const script = "$w = 'cla' + 'ude'; Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}|{4}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, [int](($_.Name -match $w) -or ($_.CommandLine -match $w)), [int]($_.CommandLine -match 'Get-CimInstance') }";
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 16 * 1024 * 1024 }).toString();
  return out.split(/\r?\n/).filter(Boolean).map((l) => l.split('|')).filter((f) => f[4] !== '1').map((f) => ({ pid: Number(f[0]), ppid: Number(f[1]), name: f[2]!, claude: f[3] === '1' }));
}
/** What is left of this test that was not there before: a descendant of this process, or any new process that says claude. */
const leftovers = (baseline: Set<number>): Proc[] => {
  const all = processes();
  const mine = new Set<number>([process.pid]);
  for (let grew = true; grew;) { grew = false; for (const p of all) if (!mine.has(p.pid) && mine.has(p.ppid)) { mine.add(p.pid); grew = true; } }
  return all.filter((p) => !baseline.has(p.pid) && p.pid !== process.pid && (mine.has(p.pid) || p.claude));
};
const baselineOf = () => new Set(processes().map((p) => p.pid));
/** Polls up to `ms` for the leftovers to go; returns what remains. */
async function noneLeft(baseline: Set<number>, ms = 10_000): Promise<Proc[]> {
  const end = Date.now() + ms;
  let left = leftovers(baseline);
  while (left.length && Date.now() < end) { await sleep(500); left = leftovers(baseline); }
  return left;
}
const namesOf = (l: Proc[]) => (l.length ? l.map((p) => `${p.name}#${p.pid}`).join(' ') : 'none');

// ---- the dry providers: one fake per branch, told apart by the branch mark in the request

/** Forwards each request to the fake of its branch (`BRANCH-B` in the body: B, else A); the model list goes to A. */
async function startRouter(a: Fake, b: Fake) {
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (d: Buffer) => parts.push(d));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      const target = new URL(body.toString().includes('BRANCH-B') ? b.url : a.url);
      const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
        res.on('close', () => r.destroy());
      });
      up.on('error', () => res.destroy());
      res.on('close', () => up.destroy());
      up.end(body);
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections(); }) };
}

// ---- reading the log

const datas = (rows: LogRow[], type: string) => rows.filter((r) => r.type === type).map((r) => r.data as Record<string, any>);
const trackRows = (rows: LogRow[], type: string, track: string) => datas(rows, type).filter((d) => d.track === track);
const usdQuestions = (rows: LogRow[]) => rows.filter((r) => r.type === 'question' && (r.data as { kind?: string }).kind === 'usd');
/** The receipt's total is rounded to 4 decimals (receipt.ts, since M1) and a track's dollars to 6: two figures of one spend agree to half of the 4th decimal. */
const NEAR = 5.1e-5;
const near = (a: number, b: number) => Math.abs(a - b) <= NEAR;
const ended = (rows: LogRow[]) => rows.some((r) => r.type === 'run_finished' || r.type === 'run_stopped');
/** The most USD questions open at one time. */
function mostUsdOpen(rows: LogRow[]): number {
  let most = 0;
  const live = new Set<string>();
  for (const r of rows) {
    const d = r.data as { id?: string; questionId?: string; kind?: string };
    if (r.type === 'question' && d.kind === 'usd') { live.add(d.id!); most = Math.max(most, live.size); }
    else if ((r.type === 'answer' || r.type === 'question_closed') && d.questionId) live.delete(d.questionId);
  }
  return most;
}

/** Starts a run through the run API and returns the log position it began after. */
async function launch(w: World, id: string, name: string, body: string): Promise<number> {
  const file = path.join(w.proj, `${name}.reins.md`);
  fs.writeFileSync(file, body);
  const mark = w.store.readLog(id).at(-1)?.seq ?? 0;
  const r = await w.api('POST', `/api/sessions/${id}/run`, { path: file });
  if (r.status !== 200) throw new Error(`POST run: ${r.status} ${r.text.slice(0, 300)}`);
  return mark;
}
const since = (w: World, id: string, mark: number) => w.store.readLog(id).filter((r) => r.seq > mark);
const note = (w: World, e: Parameters<World['evidence']>[0]) => {
  const swept = w.sweepAll();
  return record({ ...e, model: e.model ?? w.model, cost: w.budget.spent, swept }, { secrets: [w.key], ...(EVIDENCE ? { file: EVIDENCE } : {}) });
};

// ---- rows 1 to 3 share the in-process harness world

const FILES = (w: World, n: number) => { for (let i = 1; i <= n; i++) fs.writeFileSync(path.join(w.proj, `f${String(i).padStart(2, '0')}.txt`), `file ${i}\n`); };

liveSuite('M2 row 1: two branches on two engines (the claude CLI and an API provider)', { key: 'anthropic' }, () => {
  let w: World;
  let fakeB: Fake | undefined;
  let base: Set<number>;
  beforeAll(async () => {
    base = baselineOf();
    if (!REAL) fakeB = await startFakeProvider({ strictPairs: true });
    w = await startWorld({
      provider: 'anthropic', model: MODEL, prepare: ({ dir }) => installSplit(dir),
      ...(fakeB ? { copies: [{ id: 'alt', keyVar: 'REINS_LIVE_ALT_KEY', key: PROVIDERS.anthropic.shape(), edit: (m: Record<string, any>) => { m.baseUrl = fakeB!.url; } }] } : {}),
    });
    await w.consent();
    if (fakeB) await w.consent('alt');
  }, LONG);
  afterAll(async () => { await w?.close(); await fakeB?.close(); }, LONG);

  it('one branch is a turn on the API (the session engine), the other a subagent on the CLI; both finish; the receipt adds up', async () => {
    const other = REAL ? 'claude-code' : 'alt';
    w.script({ text: 'ALPHA', usage: tokens(900, 5) });
    fakeB?.push({ text: 'BRAVO', usage: tokens(700, 5) });
    const text = `${HEAD('two-engines', 0.4)}## split\nid: s\nnext: a\nnext: b\n\n${END}${phase('a', 'BRANCH-A: Reply with exactly the single word ALPHA and nothing else.')}${END}`
      + `## subagent b\nid: b\nmodel: ${other}:${MODEL}\n> BRANCH-B: Reply with exactly the single word BRAVO and nothing else.\n\n${END}`;
    const s = await w.session();
    const t0 = Date.now();
    const run = await w.workflow(s, 'two-engines', text, allowAll);
    const ms = Date.now() - t0;
    const rows = run.rows;

    expect(rows.some((r) => r.type === 'run_finished')).toBe(true);
    expect(rows.some((r) => r.type === 'run_stopped')).toBe(false);
    expect(datas(rows, 'track_started').map((d) => d.track).sort()).toEqual(['a', 'b']);
    expect(datas(rows, 'track_ended').map((d) => d.track).sort()).toEqual(['a', 'b']);
    expect(datas(rows, 'split_started')).toHaveLength(1);
    expect(datas(rows, 'split_done')).toHaveLength(1);

    // Each branch's reply is its own: A's turn says ALPHA and never BRAVO, B's subagent says BRAVO and never ALPHA.
    const aText = trackRows(rows, 'turn_ended', 'a').map((d) => String(d.text)).join(' ');
    const bText = trackRows(rows, 'subagent_result', 'b').map((d) => String(d.text)).join(' ');
    expect(aText.toUpperCase()).toContain('ALPHA');
    expect(aText.toUpperCase()).not.toContain('BRAVO');
    expect(bText.toUpperCase()).toContain('BRAVO');
    expect(bText.toUpperCase()).not.toContain('ALPHA');
    const aEnded = String(trackRows(rows, 'track_ended', 'a')[0]!.text ?? '');
    const bEnded = String(trackRows(rows, 'track_ended', 'b')[0]!.text ?? '');

    // The subagent really ran on the other engine: its started row names it.
    const subStart = datas(rows, 'subagent_started')[0]!;
    // Money: two track rows whose dollars add up to the total (no double count); the API branch equals the Budget's own count of the conversation files.
    const r = run.receipt;
    expect(r.tracks).toHaveLength(2);
    const [ta, tb] = r.tracks as Array<{ key: string; usd: number; turns: number; ended: boolean; unknown?: true }>;
    expect([ta!.key, tb!.key]).toEqual(['a', 'b']);
    expect(ta!.ended && tb!.ended).toBe(true);
    expect(ta!.usd).toBeGreaterThan(0);
    const sum = ta!.usd + tb!.usd;
    expect(near(sum, r.totalCostUsd)).toBe(true);
    expect(r.totalTurns).toBe(2);
    if (REAL) expect(sameCost(ta!.usd, w.budget.spent)).toBe(true);      // only branch A is on a wire Reins counts itself
    else expect(near(r.totalCostUsd, w.budget.spent)).toBe(true);        // dry: both branches are on a wire
    expect(w.budget.spent).toBeLessThan(0.4);

    const left = await noneLeft(base, 15_000);
    expect(namesOf(left)).toBe('none');
    note(w, {
      row: `M2-1 two branches, two engines (${REAL ? 'API + claude CLI' : 'fake + fake'})`, pass: true,
      counts: {
        trackStarted: 2, trackEnded: 2, aReply: JSON.stringify(aText.slice(0, 40)), bReply: JSON.stringify(bText.slice(0, 40)), aEndedText: JSON.stringify(aEnded.slice(0, 40)), bEndedText: JSON.stringify(bEnded.slice(0, 40)),
        trackAUsd: ta!.usd, trackBUsd: tb!.usd, sumUsd: Number(sum.toFixed(6)), totalCostUsd: r.totalCostUsd, totalTurns: r.totalTurns, budgetOwnCountUsd: Number(w.budget.spent.toFixed(6)),
        subagentStarted: JSON.stringify({ model: subStart.model, label: subStart.label }), runMs: ms, claudeProcessesLeft: namesOf(left),
      },
      notes: [`the API branch's price: ${w.priceNote(MODEL)}`, REAL ? 'branch B (subagent step with model claude-code:claude-haiku-5-5) ran on the CLI; its dollars come from the CLI, not from a conversation file' : 'dry: branch B ran on a second fake provider'],
    });
  }, LONG);
});

liveSuite('M2 row 2: Stop with a tool approval open', { key: 'anthropic' }, () => {
  let w: World;
  let base: Set<number>;
  beforeAll(async () => {
    base = baselineOf();
    w = await startWorld({ provider: 'anthropic', model: MODEL, prepare: ({ dir }) => installSplit(dir) });
    await w.consent();
  }, LONG);
  afterAll(async () => { await w?.close(); }, LONG);

  it('the run ends stopped within seconds, the cards are closed and no process of ours is left', async () => {
    // A network command: the claude CLI runs with acceptEdits, so a file write and a read-only command like Write-Output never ask; a web request does.
    // The card is never answered, so nothing is sent.
    const web = (x: string) => `Invoke-WebRequest -Uri https://example.com/${x} -UseBasicParsing`;
    const cmd = (x: string) => `Use the ${SHELL} tool to run exactly this command: ${web(x)}`;
    w.script({ ...call(SHELL, { command: web('a') }, 'toolu_a'), usage: tokens(900, 30) }, { ...call(SHELL, { command: web('b') }, 'toolu_b'), usage: tokens(900, 30) });
    const text = `${HEAD('stop-open', 0.4)}## split\nid: s\nnext: a\nnext: b\n\n${END}${phase('a', `BRANCH-A: ${cmd('a')}`)}${END}${phase('b', `BRANCH-B: ${cmd('b')}`)}${END}`;
    // In real mode the branches run on the claude CLI (the session's engine); in dry mode on the fake wire.
    const s = await w.session(REAL ? { engine: 'claude-code', model: MODEL } : {});
    const yesButTools: Handler = (q) => (q.kind === 'trust' ? 'y' : q.kind === 'tool' ? undefined : q.kind === 'switch' ? 'n' : 'stop');
    const mark = await launch(w, s, 'stop-open', text);
    await w.pump(s, () => openQuestions(w.rows(s)).some((q) => q.kind === 'tool'), yesButTools, REAL ? 180_000 : 20_000);
    if (REAL) await sleep(3000);                      // let the second branch ask too, if it will
    const open = openQuestions(w.rows(s)).filter((q) => q.kind === 'tool');
    expect(open.length).toBeGreaterThanOrEqual(1);
    const procsBefore = processes().filter((p) => !base.has(p.pid) && p.claude);

    const t0 = Date.now();
    expect((await w.stop(s)).status).toBe(200);
    await w.pump(s, () => ended(since(w, s, mark)) && since(w, s, mark).some((r) => r.type === 'receipt') && w.rows(s).at(-1)?.type === 'status', yesButTools, REAL ? 90_000 : 15_000);
    const ms = Date.now() - t0;
    const rows = since(w, s, mark);
    expect(rows.some((r) => r.type === 'run_stopped')).toBe(true);
    expect(rows.some((r) => r.type === 'run_finished')).toBe(false);
    expect(openQuestions(w.rows(s))).toEqual([]);
    expect(ms).toBeLessThan(REAL ? 30_000 : 5_000);
    const left = await noneLeft(base, 15_000);
    expect(namesOf(left)).toBe('none');
    const closedBy = datas(w.rows(s), 'question_closed').map((d) => String(d.why ?? '')).filter(Boolean);
    note(w, {
      row: `M2-2 Stop with a tool approval open (${REAL ? 'claude CLI' : 'fake'})`, pass: true,
      counts: { toolCardsOpenAtStop: open.length, stopToEndMs: ms, runEnded: 'run_stopped', openQuestionsAfter: 0, newClaudeProcessesDuringRun: procsBefore.length, processesLeftAfter: namesOf(left), closedWhy: JSON.stringify([...new Set(closedBy)]) },
      notes: [`${REAL ? 'the branches ran on the claude CLI engine (Haiku 5.5)' : 'dry: scripted tool calls on the fake wire'}`],
    });
  }, LONG);
});

liveSuite('M2 row 3: a USD limit crossed, one pause, one re-share', { key: 'anthropic' }, () => {
  let w: World;
  let a: Fake | undefined;
  let b: Fake | undefined;
  let router: Awaited<ReturnType<typeof startRouter>> | undefined;
  const LIMIT = REAL ? 0.03 : 0.03;
  const ALLOW = 0.02;
  beforeAll(async () => {
    if (!REAL) { a = await startFakeProvider({ strictPairs: true }); b = await startFakeProvider({ strictPairs: true }); router = await startRouter(a, b); }
    w = await startWorld({ provider: 'anthropic', model: MODEL, settings: { maxCallsPerTurn: 14 }, prepare: ({ dir }) => installSplit(dir), ...(router ? { edit: (m: Record<string, any>) => { m.baseUrl = router!.url; } } : {}) });
    await w.consent();
    FILES(w, 14);
  }, LONG);
  afterAll(async () => { await w?.close(); await router?.close(); await a?.close(); await b?.close(); }, LONG);

  it('a branch used up its slice: ONE USD pause tagged with it; Allow lets that track go on; the totals stay under the cap plus the allowance', async () => {
    const reads = (from: number, n: number, usage: Record<string, unknown>, prefix: string) => Array.from({ length: n }, (_, i) => ({ ...call('Read', { file_path: `f${String(from + i).padStart(2, '0')}.txt` }, `${prefix}${i}`), usage }));
    // A spends fast: two reads of about 0.008 each use its slice of 0.015. B is slow to answer (its first reply is held), so it still holds its share when A is cut.
    a?.push(...reads(1, 3, tokens(3000, 1000), 'toolu_a'), { text: 'A is done', usage: tokens(3500, 5) });
    b?.push({ ...reads(8, 1, tokens(1000, 100), 'toolu_b')[0]!, hangMs: 1200 }, { text: 'B is done', usage: tokens(1100, 5) });
    const strict = 'You must use the Read tool, ONE file per call, one call after another, and not answer in text until the last file.';
    const read = (id: string, from: number, to: number) => `${strict} Read the files f${String(from).padStart(2, '0')}.txt to f${String(to).padStart(2, '0')}.txt in the project folder with the Read tool, then say done.`;
    const text = `${HEAD('usd-share', LIMIT)}## split\nid: s\nshare: yes\nnext: a\nnext: b\n\n${END}${phase('a', `BRANCH-A: ${read('a', 1, 7)}`)}${END}${phase('b', `BRANCH-B: ${read('b', 8, 14)}`)}${END}`;
    const s = await w.session();
    let firstId: string | undefined;
    let firstAt = 0;
    let answered = 0;
    // The first card is left open for a while, so a second branch can be cut while it is open (it must not raise a second card); then Allow. Any later card: stop.
    const handler: Handler = (q, rows) => {
      if (q.kind !== 'usd') return allowAll(q, rows);
      if (!firstId) { firstId = q.id; firstAt = Date.now(); }
      if (q.id !== firstId) return 'stop';
      return Date.now() - firstAt >= (REAL ? 4000 : 1800) ? (answered++, `allow ${ALLOW}`) : undefined;
    };
    const run = await w.workflow(s, 'usd-share', text, handler);
    const rows = run.rows;
    const reached = datas(rows, 'budget_reached');
    const cards = usdQuestions(rows);
    expect(reached.length).toBeGreaterThanOrEqual(1);
    expect(reached[0]!.track === 'a' || reached[0]!.track === 'b').toBe(true);       // tagged with the track
    expect(mostUsdOpen(rows)).toBe(1);                                                // never two cards at once
    expect(cards.length).toBe(reached.length);                                        // one card per pause row
    expect(answered).toBe(1);
    const first = String(reached[0]!.track);
    // After the Allow the tagged track goes on: it has a turn or a tool call logged after the answer.
    const answerSeq = rows.find((r) => r.type === 'answer' && (r.data as { questionId: string }).questionId === firstId)!.seq;
    const after = rows.filter((r) => r.seq > answerSeq);
    const wentOn = after.some((r) => (r.data as { track?: string }).track === first && (r.type === 'turn_started' || r.type === 'turn_ended' || r.type === 'engine'));
    expect(wentOn).toBe(true);
    expect(run.receipt).toBeTruthy();
    const total = run.receipt.totalCostUsd as number;
    const biggest = Math.max(...datas(rows, 'turn_ended').map((d) => Number(d.cost ?? 0)));
    // The cap plus the allowance, plus at most one call in flight per branch (plan section 3, P3).
    expect(total).toBeLessThanOrEqual(LIMIT + ALLOW + 2 * biggest);
    expect(near(total, w.budget.spent)).toBe(true);
    const ending = rows.find((r) => r.type === 'run_finished' || r.type === 'run_stopped')!.type;
    if (!REAL) { expect(ending).toBe('run_finished'); expect(cards).toHaveLength(1); expect(first).toBe('a'); }
    note(w, {
      row: `M2-3 USD limit crossed, one pause (${REAL ? 'Haiku 5.5 on the API' : 'fake'})`, pass: true,
      counts: {
        limitUsd: LIMIT, allowUsd: ALLOW, usdCards: cards.length, budgetReachedRows: reached.length, firstCardTrack: first, otherCardTracks: JSON.stringify(reached.slice(1).map((d) => d.track)),
        mostCardsOpenAtOnce: mostUsdOpen(rows), firstTrackWentOnAfterAllow: wentOn, budgetWarningRows: datas(rows, 'budget_warning').length, ended: ending,
        receiptTotalUsd: total, ownCountUsd: Number(w.budget.spent.toFixed(6)), trackUsd: JSON.stringify((run.receipt.tracks ?? []).map((t: any) => [t.key, t.usd])),
      },
      notes: [`price: ${w.priceNote(MODEL)}`, 'the limit is the workflow usd; the split block says share: yes, so each branch has half of it as its slice'],
    });
  }, LONG);
});

// ---- row 4: the server is a separate process, killed hard

interface Child { proc: ChildProcess; port: number; token: string; out: string[]; dead: Promise<void> }
const killTree = (c: Child) => { try { execFileSync('taskkill', ['/PID', String(c.proc.pid), '/F', '/T'], { stdio: 'ignore' }); } catch { /* already gone */ } };
const isLive = (c: Child) => c.proc.exitCode === null && c.proc.signalCode === null;

interface Home { root: string; dir: string; proj: string; key: string; keyVar: string; env: NodeJS.ProcessEnv }
function makeHome(baseUrl: string): Home {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-m2k-')));
  const dir = path.join(root, '.reins');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(dir, 'mods', 'anthropic'), { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  const spec = PROVIDERS.anthropic;
  const key = REAL ? process.env[spec.keyVar] || spec.shape() : spec.shape();   // on the CLI variant the API is never called: the made-up key only fills the manifest's variable
  const m = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, 'anthropic', 'mod.json'), 'utf8')) as Record<string, any>;
  m.auth = { ...m.auth, keyEnv: [spec.keyVar] };
  delete m.catalog;
  if (!REAL) m.baseUrl = baseUrl;
  for (const x of m.models as Array<{ id: string; price?: unknown }>) if (x.id === MODEL && !x.price) x.price = ASSUMED;
  fs.writeFileSync(path.join(dir, 'mods', 'anthropic', 'mod.json'), JSON.stringify(m, null, 2));
  installSplit(dir);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^REINS_/i.test(k) && !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k)) env[k] = v;
  env[spec.keyVar] = key;
  env.REINS_HOME = root;
  return { root, dir, proj, key, keyVar: spec.keyVar, env };
}

/** `reins serve` from the built package, as a separate process; resolves with its address. */
async function startChild(h: Home): Promise<Child> {
  const proc = spawn(process.execPath, [DIST_CLI, 'serve', '--port', '0'], { cwd: h.root, env: h.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const out: string[] = [];
  const dead = new Promise<void>((ok) => { proc.once('exit', () => ok()); });
  proc.stderr!.on('data', (d: Buffer) => out.push(d.toString()));
  const url = await new Promise<string>((ok, bad) => {
    let buf = '';
    const timer = setTimeout(() => bad(new Error(`the server printed no address in 60 s; output: ${out.join('').slice(0, 300)}`)), 60_000);
    proc.stdout!.on('data', (d: Buffer) => {
      out.push(d.toString());
      buf += d.toString();
      const m = /http:\/\/127\.0\.0\.1:(\d+)\/#token=(\S+)/.exec(buf);
      if (m) { clearTimeout(timer); ok(m[0]); }
    });
    proc.once('exit', (code) => { clearTimeout(timer); bad(new Error(`the server exited (${code}) before it printed an address; output: ${out.join('').slice(0, 300)}`)); });
  });
  const m = /:(\d+)\/#token=(\S+)/.exec(url)!;
  return { proc, port: Number(m[1]), token: m[2]!, out, dead };
}

const api = (c: Child, method: 'GET' | 'POST', url: string, body?: unknown) => request(c, method, url, body === undefined ? {} : { body });
const logOf = async (c: Child, id: string): Promise<LogRow[]> => ((await api(c, 'GET', `/api/sessions/${id}/log?after=0`)).json?.rows ?? []) as LogRow[];

async function pumpChild(c: Child, id: string, done: (rows: LogRow[]) => boolean, handler: Handler, ms: number): Promise<LogRow[]> {
  const answered = new Set<string>();
  const end = Date.now() + ms;
  for (;;) {
    const rows = await logOf(c, id);
    for (const q of openQuestions(rows)) {
      if (answered.has(q.id)) continue;
      const a = handler(q, rows);
      if (a === undefined) continue;
      answered.add(q.id);
      await api(c, 'POST', `/api/sessions/${id}/answer`, { questionId: q.id, answer: a });
    }
    if (done(rows)) return rows;
    if (Date.now() > end) throw new Error(`Timed out after ${ms} ms waiting on session ${id}.`);
    await sleep(REAL ? 300 : 40);
  }
}

/** The model-call cost the conversation files hold, by the manifest price (the Budget's own count). */
function convoCost(dir: string): number {
  const d = path.join(dir, 'conversations');
  if (!fs.existsSync(d)) return 0;
  return fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).reduce((a, f) => a + rawUsage(conversationLines(dir, f.slice(0, -'.jsonl'.length))).reduce((b, u) => b + costOf(u, ASSUMED), 0), 0);
}

const STEPS = (name: string, usd: number) => {
  // The CLI asks about a web request, not about Write-Output (acceptEdits and read-only commands pass by themselves).
  const tool = (x: string) => `Use the ${SHELL} tool to run exactly this command: ${CLI4 ? `Invoke-WebRequest -Uri https://example.com/${x} -UseBasicParsing | Select-Object -ExpandProperty StatusCode` : `Write-Output ${x}`}`;
  return `${HEAD(name, usd)}## split\nid: s\nnext: a1\nnext: b1\n\n${END}`
    + phase('a1', 'BRANCH-A step one: reply with exactly A1-DONE and nothing else.') + phase('a2', `BRANCH-A step two: ${tool('a2-done')}`) + END
    + phase('b1', 'BRANCH-B step one: reply with exactly B1-DONE and nothing else.') + phase('b2', `BRANCH-B step two: ${tool('b2-done')}`) + END;
};

describe.skipIf(!fs.existsSync(DIST_CLI) || (REAL && !CLI4 && !process.env[PROVIDERS.anthropic.keyVar]))('M2 row 4: restore mid-split after the server process was killed', () => {
  const homes: Home[] = [];
  const children: Child[] = [];
  const fakes: Array<{ close(): Promise<unknown> }> = [];
  afterEach(async () => {
    for (const c of children.splice(0)) { if (isLive(c)) killTree(c); await c.dead; }
    for (const f of fakes.splice(0)) await f.close();
    for (const h of homes.splice(0)) { try { fs.rmSync(h.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* left for the OS temp cleaner */ } }
  }, LONG);

  /** Fakes for dry mode: A and B behind one router. Real mode: none. */
  async function providers() {
    if (REAL) return { a: undefined, b: undefined, url: '' };
    const a = await startFakeProvider({ strictPairs: true });
    const b = await startFakeProvider({ strictPairs: true });
    const router = await startRouter(a, b);
    fakes.push(a, b, router);
    return { a, b, url: router.url };
  }
  const trustAndTools: Handler = (q) => (q.kind === 'trust' ? 'y' : q.kind === 'tool' ? undefined : q.kind === 'switch' ? 'n' : 'stop');
  const yes: Handler = (q) => (q.kind === 'trust' || q.kind === 'tool' ? 'y' : q.kind === 'switch' ? 'n' : 'stop');

  /** Starts a server, a session and the split run, waits until both branches have a tool card open (in flight), and kills the process. */
  async function toTheKill(h: Home, fakesOf: Awaited<ReturnType<typeof providers>>, name: string) {
    const base = baselineOf();
    const c1 = await startChild(h);
    children.push(c1);
    if (!CLI4) {
      const consent = await api(c1, 'POST', '/api/mods/anthropic/consent', { origin: new URL(REAL ? 'https://api.anthropic.com' : fakesOf.url).origin });
      expect(consent.status).toBe(200);
    }
    const made = await api(c1, 'POST', '/api/sessions', { cwd: h.proj, engine: CLI4 ? 'claude-code' : 'anthropic', model: MODEL });
    expect(made.status).toBe(200);
    const sid = made.json.id as string;
    fs.writeFileSync(path.join(h.proj, `${name}.reins.md`), STEPS(name, 0.4));
    const started = await api(c1, 'POST', `/api/sessions/${sid}/run`, { path: path.join(h.proj, `${name}.reins.md`) });
    expect(started.status).toBe(200);
    const rows = await pumpChild(c1, sid, (r) => ['a1', 'b1'].every((k) => openQuestions(r).some((q) => q.kind === 'tool' && q.owner === k)), trustAndTools, REAL ? 240_000 : 20_000);
    const rid = rows.find((r) => r.runId)!.runId!;
    const before = { rows, turnEnded: datas(rows, 'turn_ended'), cost: convoCost(h.dir) };
    // A hard kill: no clean close, no detach. With the API only the server is killed (nothing else was started); on the CLI variant ONLY the server
    // process is killed, not its tree, so what the claude processes do when their server dies shows, and is then cleaned up here.
    if (CLI4) { try { execFileSync('taskkill', ['/PID', String(c1.proc.pid), '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } } else killTree(c1);
    await c1.dead;
    expect(isLive(c1)).toBe(false);
    let orphans = 'n/a';
    if (CLI4) {
      await sleep(5000);
      const left = leftovers(base);
      orphans = namesOf(left);
      for (const p of left) { try { execFileSync('taskkill', ['/PID', String(p.pid), '/F', '/T'], { stdio: 'ignore' }); } catch { /* gone */ } }
    }
    return { sid, rid, before, orphans };
  }

  it('the finished steps are not run again, nothing is billed twice, and the run finishes', async () => {
    const f = await providers();
    const h = makeHome(f.url);
    homes.push(h);
    const tool = (name: string, id: string) => ({ ...call(SHELL, { command: `Write-Output ${name}` }, id), usage: tokens(1200, 30) });
    f.a?.push({ text: 'A1-DONE', usage: tokens(900, 5) }, tool('a2-done', 'toolu_a2'));
    f.b?.push({ text: 'B1-DONE', usage: tokens(900, 5) }, tool('b2-done', 'toolu_b2'));
    const reqsA0 = () => f.a?.requests.filter((r) => r.path.endsWith('/messages')).length ?? 0;
    const reqsB0 = () => f.b?.requests.filter((r) => r.path.endsWith('/messages')).length ?? 0;
    const k = await toTheKill(h, f, 'kill-resume');
    const stepsBefore = k.before.turnEnded.map((d) => `${d.track}/${d.step}`).sort();
    const sentBefore = reqsA0() + reqsB0();

    // The new process on the same home. After the restart the run reads as detached; Resume restores it.
    f.a?.push(tool('a2-done', 'toolu_a2b'), { text: 'A2-DONE', usage: tokens(1400, 5) });
    f.b?.push(tool('b2-done', 'toolu_b2b'), { text: 'B2-DONE', usage: tokens(1400, 5) });
    const c2 = await startChild(h);
    children.push(c2);
    const afterRestart = await logOf(c2, k.sid);
    expect(afterRestart.some((r) => r.type === 'run_detached' && r.runId === k.rid)).toBe(true);
    expect(openQuestions(afterRestart)).toEqual([]);
    const resumed = await api(c2, 'POST', `/api/sessions/${k.sid}/resume`, { runId: k.rid });
    expect(resumed.status).toBe(200);
    const t0 = Date.now();
    const rows = await pumpChild(c2, k.sid, (r) => r.some((x) => x.type === 'receipt' && x.runId === k.rid), yes, REAL ? 240_000 : 20_000);
    const ms = Date.now() - t0;

    expect(rows.some((r) => r.type === 'run_finished' && r.runId === k.rid)).toBe(true);
    const turns = datas(rows, 'turn_ended').map((d) => `${d.track}/${d.step}`);
    // Each step answered exactly once: the finished ones were not run again, the ones in flight at the kill ran once more.
    for (const step of ['a1/a1', 'b1/b1']) expect(turns.filter((t) => t === step), step).toHaveLength(1);
    for (const step of ['a1/a2', 'b1/b2']) expect(turns.filter((t) => t === step), step).toHaveLength(1);
    expect(stepsBefore).toEqual(['a1/a1', 'b1/b1']);
    expect(datas(rows, 'track_started').map((d) => d.track).sort()).toEqual(['a1', 'b1']);
    expect(datas(rows, 'track_ended').map((d) => d.track).sort()).toEqual(['a1', 'b1']);
    const sentAfter = reqsA0() + reqsB0() - sentBefore;
    if (!REAL) expect(sentAfter).toBe(4);   // a2 and b2 again (the tool call) and their answers after the tool ran; a1 and b1 not at all

    // Money: the receipt is every turn once. It is not above the Budget's own count of the conversation files (a double bill would be), and it
    // is not below it by more than the calls that were cut off by the kill and so never ended a turn.
    const receipt = rows.find((r) => r.type === 'receipt' && r.runId === k.rid)!.data as any;
    const eachTurn = datas(rows, 'turn_ended').reduce((a, d) => a + Number(d.cost ?? 0), 0);
    // The CLI variant has no conversation files of Reins's own to count: its check is the turns, the receipt and the track rows against each other.
    const own = CLI4 ? eachTurn : convoCost(h.dir);
    expect(near(receipt.totalCostUsd, eachTurn)).toBe(true);
    expect(receipt.totalCostUsd).toBeLessThanOrEqual(own + NEAR);
    const lost = own - receipt.totalCostUsd;
    expect(lost).toBeLessThan(REAL ? 0.02 : 0.003);
    const trackSum = (receipt.tracks as Array<{ usd: number }>).reduce((a, t) => a + t.usd, 0);
    expect(near(trackSum, receipt.totalCostUsd)).toBe(true);

    const swept = sweep(h.root, h.key, [{ name: 'server output 1', text: children[0]!.out.join('') }, { name: 'server output 2', text: c2.out.join('') }]);
    expect(swept.hits).toEqual([]);
    record({
      row: `M2-4a restore mid-split after a hard server kill (${CLI4 ? 'CLI VARIANT: Haiku 5.5 on the claude CLI, not the API' : REAL ? 'Haiku 5.5 on the API' : 'fake'})`, model: MODEL, pass: true, cost: own, swept,
      counts: {
        claudeProcessesLeftByTheKill: k.orphans,
        finishedBeforeKill: JSON.stringify(stepsBefore), costBeforeKillUsd: Number(k.before.cost.toFixed(6)), stepsAnswered: JSON.stringify(turns.sort()),
        trackStarted: 2, trackEnded: 2, requestsAfterResume: REAL ? 'n/a' : sentAfter, resumeToEndMs: ms,
        receiptTotalUsd: receipt.totalCostUsd, sumOfTurnCostsUsd: Number(eachTurn.toFixed(6)), ownCountUsd: Number(own.toFixed(6)), cutOffCallsUsd: Number(lost.toFixed(6)), trackUsd: JSON.stringify((receipt.tracks ?? []).map((t: any) => [t.key, t.usd])),
      },
      notes: [`the server was killed with taskkill /F${CLI4 ? ' (the server process only; leftovers were then killed by the test)' : ' /T'} while both branches had a tool card open; the second process was started on the same home and the run resumed through POST /resume`],
    }, { secrets: [h.key], ...(EVIDENCE ? { file: EVIDENCE } : {}) });
  }, LONG);

  it('a restore after the block mod changed its version pauses with the "saved with other blocks" words and runs nothing', async () => {
    const f = await providers();
    const h = makeHome(f.url);
    homes.push(h);
    const tool = (name: string, id: string) => ({ ...call(SHELL, { command: `Write-Output ${name}` }, id), usage: tokens(1200, 30) });
    f.a?.push({ text: 'A1-DONE', usage: tokens(900, 5) }, tool('a2-done', 'toolu_a2'));
    f.b?.push({ text: 'B1-DONE', usage: tokens(900, 5) }, tool('b2-done', 'toolu_b2'));
    const k = await toTheKill(h, f, 'kill-version');
    const sent = () => (f.a?.requests.length ?? 0) + (f.b?.requests.length ?? 0);
    const sentBefore = sent();
    const turnsBefore = k.before.turnEnded.length;

    installSplit(h.dir, '1.0.1');                                       // the mod's version changed while the server was down (and the user trusted it again)
    const c2 = await startChild(h);
    children.push(c2);
    const resumed = await api(c2, 'POST', `/api/sessions/${k.sid}/resume`, { runId: k.rid });
    expect(resumed.status).toBe(200);
    const rows = await pumpChild(c2, k.sid, (r) => r.some((x) => x.type === 'run_paused' && x.runId === k.rid) || r.some((x) => x.type === 'question' && /other blocks/.test(String((x.data as any).prompt ?? '') + String((x.data as any).detail ?? ''))), (q) => (q.kind === 'trust' ? 'y' : undefined), REAL ? 60_000 : 15_000);
    const paused = datas(rows, 'run_paused').at(-1);
    const text = String(paused?.text ?? '') + openQuestions(rows).map((q) => `${q.prompt} ${q.detail ?? ''}`).join(' ');
    expect(text).toContain('saved with other blocks (split)');
    await sleep(REAL ? 3000 : 400);
    const mid = await logOf(c2, k.sid);
    // Nothing ran: no turn began or ended after the resume, no request reached a provider.
    const after = mid.filter((r) => r.seq > Math.max(...rows.filter((x) => x.type === 'note' && /Resumed run/.test(String((x.data as any).text))).map((x) => x.seq), 0));
    expect(after.filter((r) => r.type === 'turn_started' || r.type === 'turn_ended')).toEqual([]);
    expect(datas(mid, 'turn_ended')).toHaveLength(turnsBefore);
    if (!REAL) expect(sent()).toBe(sentBefore);
    // Stop it, as the words offer; the run ends stopped and the session is idle.
    const q = openQuestions(mid).find((x) => x.kind === 'resume' || x.kind === 'budget' || x.kind === 'gate') ?? openQuestions(mid)[0];
    const stopped = await api(c2, 'POST', `/api/sessions/${k.sid}/card`, { text: '', kind: 'stop' });
    expect(stopped.status).toBe(200);
    const end = await pumpChild(c2, k.sid, (r) => r.some((x) => x.type === 'run_stopped' && x.runId === k.rid), () => 'stop', 60_000);
    expect(end.some((r) => r.type === 'run_stopped')).toBe(true);
    record({
      row: `M2-4b restore after the mod's version changed (${CLI4 ? 'CLI VARIANT: claude CLI, not the API' : REAL ? 'API' : 'fake'})`, model: MODEL, pass: true, cost: convoCost(h.dir),
      counts: { pausedWith: JSON.stringify(text.slice(0, 160)), questionKind: q?.kind ?? 'none', turnsBeforeKill: turnsBefore, turnsRunAfterResume: 0, requestsToProviderAfterResume: REAL ? 'n/a' : sent() - sentBefore, endedBy: 'Stop' },
      notes: ['production wiring: the second process was `reins serve` from dist/cli.js (cli.ts -> serve.ts -> server.ts deps.kinds = kindVersions(mods)); mod.json version 1.0.0 -> 1.0.1 and the trust file rewritten'],
    }, { secrets: [h.key], ...(EVIDENCE ? { file: EVIDENCE } : {}) });
  }, LONG);
});
