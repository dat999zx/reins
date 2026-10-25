// Milestone M3, the orchestrator's live checks of `fork` and `playbook` (both are bundled pack mods now), against real providers (REINS_LIVE=1) or, in the normal
// suite, the scripted fake (the dry rows prove the same assertions). Six rows: a fork over two engines, a fork with a failed branch, an inline playbook with an
// input, an own-session playbook with a USD cap, an envelope round trip between two homes, and a hard kill of the server in the middle of a fork.
// A secret never leaves this file: evidence goes through `record`, which refuses a block with a key.
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
import { CODE_PROMPT } from '../../src/mods/actions.js';
import { hashFiles, readFolder } from '../../src/mods/loader.js';
import { loadWorkflowText } from '../../src/run-cli.js';
import type { LogRow } from '../../src/store.js';
import { commandsOf, hashCommands } from '../../src/trust.js';
import { startFakeProvider } from '../fake-provider.js';
import { openQuestions, request } from '../http-helpers.js';
import {
  LONG, MODE, PROVIDERS, SHELL, allowAll, asText, call, conversationLines, costOf, liveSuite, rawUsage, record, sameCost, sleep, startWorld, sweep, tokens,
  type Handler, type SweepResult, type World,
} from './live-harness.js';

type Fake = Awaited<ReturnType<typeof startFakeProvider>>;
const MODEL = 'claude-haiku-5-5';
const REAL = MODE === 'real';
const ASSUMED = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const DIST_CLI = path.join(REPO, 'packages', 'server', 'dist', 'cli.js');
/** Real runs are written to the file of this milestone; dry runs have the harness's own file, so a rehearsal never reads as evidence. */
const EVIDENCE = REAL ? path.join(REPO, 'docs', 'plan', 'm3-real-checks.md') : undefined;
/** The most any one row may cost by the Budget's own count (the claude CLI's dollars are on the receipt, never in this count). All six rows together stay under US$0.60. */
const CAPS = { fork: 0.12, failed: 0.05, inline: 0.08, own: 0.08, envelope: 0.05, kill: 0.12 };

const HEAD = (name: string, usd?: number) => `---\nreins: 1\nname: ${name}\nbudget: { turns: 40, minutes: 15${usd === undefined ? '' : `, usd: ${usd}`} }\nalways: []\n---\n\n`;
const END = '## end\n\n';

// ---- processes (as in the M2 file)

interface Proc { pid: number; ppid: number; name: string; claude: boolean }
/** Every process now: id, parent, name, and whether its name or command line says claude. The command line is read here and never kept. */
function processes(): Proc[] {
  if (process.platform !== 'win32') {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,args=']).toString().split('\n').filter(Boolean).filter((l) => !/ ps -eo pid=,ppid=,args=\s*$/.test(l)); // not the listing's own process: a child of this one, never in the baseline
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
/** The receipt's total is rounded to 4 decimals and a track's dollars to 6: two figures of one spend agree to half of the 4th decimal. */
const NEAR = 5.1e-5;
const near = (a: number, b: number) => Math.abs(a - b) <= NEAR;
const ended = (rows: LogRow[]) => rows.some((r) => r.type === 'run_finished' || r.type === 'run_stopped');
const over = (rows: LogRow[]) => rows.some((r) => r.type === 'run_detached') || (ended(rows) && rows.some((r) => r.type === 'receipt'));
/** The turns of the main line (no track) that answered a step. */
const mainTurns = (rows: LogRow[], step: string) => datas(rows, 'turn_ended').filter((d) => d.track === undefined && d.step === step);
type TrackRow = { key: string; usd: number; turns: number; ended: boolean; title?: string; unknown?: true };

interface Gone { mark: number; rid: string; rows: LogRow[]; receipt: any; ids: Map<string, string> }
const since = (w: World, id: string, mark: number) => w.store.readLog(id).filter((r) => r.seq > mark);

/** Starts a run of a workflow file through the run API and returns the log position it began after. */
async function launch(w: World, id: string, file: string): Promise<number> {
  const mark = w.store.readLog(id).at(-1)?.seq ?? 0;
  const r = await w.api('POST', `/api/sessions/${id}/run`, { path: file });
  if (r.status !== 200) throw new Error(`POST run: ${r.status} ${r.text.slice(0, 300)}`);
  return mark;
}
/**
 * Writes the workflow, runs it, answers with `handler`, and watches the saved snapshot while it runs: the session ids of the tracks and the subagents are only
 * there while they live. `until` replaces "the run ended" as the end of the wait (a row that stops the run itself).
 */
async function go(w: World, id: string, name: string, body: string, handler: Handler, o: { until?: (rows: LogRow[]) => boolean; ms?: number; file?: string } = {}): Promise<Gone> {
  w.budget.check();
  const file = o.file ?? path.join(w.proj, `${name}.reins.md`);
  if (!o.file) fs.writeFileSync(file, body);
  const mark = await launch(w, id, file);
  const ids = new Map<string, string>();
  const look = () => {
    const rid = since(w, id, mark).find((r) => r.runId)?.runId;
    const snap = rid ? (w.store.loadRun(rid)?.snapshot as any) : undefined;
    for (const t of snap?.tracks ?? []) if (t.sessionId) ids.set(`track ${t.key}`, t.sessionId);
    for (const [k, v] of Object.entries(snap?.subagents ?? {})) if ((v as any)?.sessionId) ids.set(`subagent ${k}`, (v as any).sessionId);
  };
  await w.pump(id, () => { look(); const rows = since(w, id, mark); return o.until ? o.until(rows) : over(rows); }, handler, o.ms);
  look();
  const rows = since(w, id, mark);
  return { mark, rid: rows.find((r) => r.runId)?.runId ?? '', rows, receipt: rows.find((r) => r.type === 'receipt')?.data, ids };
}
const note = (w: World, e: Parameters<World['evidence']>[0]) => {
  const swept = w.sweepAll();
  return record({ ...e, model: e.model ?? w.model, cost: w.budget.spent, swept }, { secrets: [w.key], ...(EVIDENCE ? { file: EVIDENCE } : {}) });
};
/** The conversation file of the session's own engine session, as text (what the engine was sent and said). */
const convoText = (w: World, id: string): string => {
  const engine = w.store.getSession(id)?.engineSessionId;
  return engine ? JSON.stringify(conversationLines(w.dir, engine)) : '';
};

// ---- row 1: a fork with a branch on the API and a branch on the claude CLI

liveSuite('M3 row 1: a fork over two engines (an API provider and the claude CLI), then a turn that sees both', { key: 'anthropic' }, () => {
  let w: World;
  let fakeB: Fake | undefined;
  let base: Set<number>;
  beforeAll(async () => {
    base = baselineOf();
    if (!REAL) fakeB = await startFakeProvider({ strictPairs: true });
    w = await startWorld({
      provider: 'anthropic', model: MODEL, budget: CAPS.fork,
      ...(fakeB ? { copies: [{ id: 'alt', keyVar: 'REINS_LIVE_ALT_KEY', key: PROVIDERS.anthropic.shape(), edit: (m: Record<string, any>) => { m.baseUrl = fakeB!.url; } }] } : {}),
    });
    await w.consent();
    if (fakeB) await w.consent('alt');
  }, LONG);
  afterAll(async () => { await w?.close(); await fakeB?.close(); }, LONG);

  it('both branches run in their own sessions, fork_started and fork_done once, a cost per branch, and the turn after the fork gets both replies', async () => {
    const other = REAL ? 'claude-code' : 'alt';
    w.script({ text: 'ALPHA is the word of the first branch.', usage: tokens(900, 12) }, { text: 'The branches said ALPHA and BRAVO.', usage: tokens(1200, 12) });
    fakeB?.push({ text: 'BRAVO is the word of the second branch.', usage: tokens(700, 12) });
    const text = `${HEAD('fork-two-engines', CAPS.fork)}## fork\nid: f\nnext: a\nnext: b\n\n`
      + `## phase Final\nid: final\n> Using the two branch results above, write one short sentence that contains both ALPHA and BRAVO.\n\n${END}`
      + `## phase Alpha branch\nid: a\n> BRANCH-A: Reply with exactly one short sentence that contains the word ALPHA.\n\n${END}`
      + `## subagent Bravo branch\nid: b\nmodel: ${other}:${MODEL}\n> BRANCH-B: Reply with exactly one short sentence that contains the word BRAVO.\n\n${END}`;
    const s = await w.session();
    const t0 = Date.now();
    const run = await go(w, s, 'fork-two-engines', text, allowAll);
    const ms = Date.now() - t0;
    const rows = run.rows;

    expect(rows.some((r) => r.type === 'run_finished')).toBe(true);
    expect(rows.some((r) => r.type === 'run_stopped')).toBe(false);
    expect(datas(rows, 'fork_started')).toHaveLength(1);
    expect(datas(rows, 'fork_done')).toHaveLength(1);
    expect(datas(rows, 'fork_started')[0]).toMatchObject({ step: 'f', branches: 2 });
    expect(datas(rows, 'track_started').map((d) => d.track).sort()).toEqual(['a', 'b']);
    expect(datas(rows, 'track_ended').map((d) => d.track).sort()).toEqual(['a', 'b']);
    const seq = (type: string) => rows.find((r) => r.type === type)!.seq;
    expect(seq('fork_started')).toBeLessThan(seq('fork_done'));
    expect(Math.max(...rows.filter((r) => r.type === 'track_ended').map((r) => r.seq))).toBeLessThan(seq('fork_done'));

    // Two sessions of their own, and neither is the session of the main line.
    const mainId = w.store.getSession(s)!.engineSessionId;
    const a = run.ids.get('track a');
    const b = run.ids.get('subagent b') ?? run.ids.get('track b');
    expect(a, JSON.stringify([...run.ids.keys()])).toBeTruthy();
    expect(b, JSON.stringify([...run.ids.keys()])).toBeTruthy();
    expect(a).not.toBe(b);
    expect([a, b]).not.toContain(mainId);

    // Each branch's reply is its own.
    const aEnded = String(datas(rows, 'track_ended').find((d) => d.track === 'a')!.text ?? '');
    const bEnded = String(datas(rows, 'track_ended').find((d) => d.track === 'b')!.text ?? '');
    expect(aEnded.toUpperCase()).toContain('ALPHA');
    expect(aEnded.toUpperCase()).not.toContain('BRAVO');
    expect(bEnded.toUpperCase()).toContain('BRAVO');
    expect(bEnded.toUpperCase()).not.toContain('ALPHA');

    // The receipt: a row per branch with its own dollars; the total is the branches plus the main line's one turn.
    const r = run.receipt;
    expect(r.counts).toMatchObject({ forks: 1 });
    const tracks = r.tracks as TrackRow[];
    expect(tracks.map((t) => t.key)).toEqual(['a', 'b']);
    expect(tracks.every((t) => t.ended)).toBe(true);
    for (const t of tracks) expect(t.usd, `track ${t.key} has a cost`).toBeGreaterThan(0);
    const finals = mainTurns(rows, 'final');
    expect(finals).toHaveLength(1);
    const finalCost = Number(finals[0]!.cost ?? 0);
    const sum = tracks.reduce((x, t) => x + t.usd, 0) + finalCost;
    expect(near(sum, r.totalCostUsd), `${sum} vs ${r.totalCostUsd}`).toBe(true);
    const apiOwn = tracks[0]!.usd + finalCost;
    if (REAL) expect(sameCost(apiOwn, w.budget.spent)).toBe(true);        // only the API branch and the final turn are on a wire Reins counts itself
    else expect(near(r.totalCostUsd, w.budget.spent)).toBe(true);          // dry: both branches are on a wire
    expect(w.budget.spent).toBeLessThan(CAPS.fork);

    // The turn after the fork saw both results (the engine's conversation holds them, quoted) and mentions both.
    const sent = convoText(w, s);
    expect(sent).toContain('Result of Branch Alpha branch (step a)');
    expect(sent).toContain('Result of Branch Bravo branch (step b)');
    const finalText = String(finals[0]!.text ?? '').toUpperCase();
    const mentionsBoth = finalText.includes('ALPHA') && finalText.includes('BRAVO');
    expect(mentionsBoth, finalText.slice(0, 120)).toBe(true);

    const left = await noneLeft(base, 15_000);
    expect(namesOf(left)).toBe('none');
    note(w, {
      row: `M3-1 fork over two engines (${REAL ? 'API + claude CLI' : 'fake + fake'})`, pass: true,
      counts: {
        forkStarted: 1, forkDone: 1, trackStarted: 2, trackEnded: 2, sessionsSeen: new Set(run.ids.values()).size, mainSessionDifferent: true,
        aReply: JSON.stringify(aEnded.slice(0, 60)), bReply: JSON.stringify(bEnded.slice(0, 60)), finalReply: JSON.stringify(finalText.slice(0, 80)),
        trackAUsd: tracks[0]!.usd, trackBUsd: tracks[1]!.usd, finalTurnUsd: finalCost, totalCostUsd: r.totalCostUsd, budgetOwnCountUsd: Number(w.budget.spent.toFixed(6)), runMs: ms, processesLeft: namesOf(left),
      },
      notes: [`the API branch's price: ${w.priceNote(MODEL)}`, REAL ? 'branch b (subagent step with model claude-code:claude-haiku-5-5) ran on the CLI; its dollars come from the CLI, not from a conversation file' : 'dry: branch b ran on a second fake provider'],
    });
  }, LONG);
});

// ---- row 2: a fork with a failed branch

liveSuite('M3 row 2: a fork whose second branch fails: the other ends, the fork waits, the failed one pauses alone, Stop ends it all', { key: 'anthropic' }, () => {
  let w: World;
  let fakeB: Fake | undefined;
  let base: Set<number>;
  beforeAll(async () => {
    base = baselineOf();
    if (!REAL) fakeB = await startFakeProvider({ strictPairs: true });
    w = await startWorld({
      provider: 'anthropic', model: MODEL, budget: CAPS.failed,
      ...(fakeB ? { copies: [{ id: 'alt', keyVar: 'REINS_LIVE_ALT_KEY', key: PROVIDERS.anthropic.shape(), edit: (m: Record<string, any>) => { m.baseUrl = fakeB!.url; } }] } : {}),
    });
    await w.consent();
    if (fakeB) await w.consent('alt');
  }, LONG);
  afterAll(async () => { await w?.close(); await fakeB?.close(); }, LONG);

  it('branch a ends, the fork does not finish, branch b pauses alone with a readable reason, and Stop leaves nothing running', async () => {
    // The unknown model is on ANOTHER provider than the session's: the run-start check refuses an unknown model of the session's own provider, not of a second one.
    const bogus = REAL ? 'claude-code:claude-no-such-model-0' : 'alt:no-such-model-0';
    w.script({ text: 'ALPHA is fine.', usage: tokens(900, 8) });
    fakeB?.push({ status: 404, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'model: no-such-model-0' } }) });
    const text = `${HEAD('fork-failed')}## fork\nid: f\nnext: a\nnext: b\n\n`
      + `## phase Final\nid: final\n> Say done.\n\n${END}`
      + `## phase Alpha branch\nid: a\n> Reply with exactly one short sentence that contains the word ALPHA.\n\n${END}`
      + `## subagent Broken branch\nid: b\nmodel: ${bogus}\n> Reply with one short sentence.\n\n${END}`;
    const s = await w.session();
    // The failed branch's card (kind resume) is left open: the handler never answers it.
    const handler: Handler = (q, rows) => (q.kind === 'resume' ? undefined : allowAll(q, rows));
    const failedCard = (rows: LogRow[]) => openQuestions(rows).filter((q) => q.kind === 'resume');
    const first = await go(w, s, 'fork-failed', text, handler, {
      until: (rows) => datas(rows, 'track_ended').some((d) => d.track === 'a') && failedCard(w.store.readLog(s)).length >= 1, ms: REAL ? 180_000 : 20_000,
    });
    if (REAL) await sleep(2000);                      // anything else that was going to pause or end would have by now
    const rows = since(w, s, first.mark);
    const cards = failedCard(w.store.readLog(s));

    expect(datas(rows, 'track_ended').map((d) => d.track)).toEqual(['a']);       // a ended, b did not
    expect(datas(rows, 'fork_started')).toHaveLength(1);
    expect(datas(rows, 'fork_done')).toEqual([]);                                  // the fork waits
    expect(mainTurns(rows, 'final')).toEqual([]);                                  // and the block under it is not sent
    const pausedRows = datas(rows, 'run_paused');                                  // the run is not paused; one branch is: every pause row names branch b
    expect(pausedRows.length).toBeGreaterThanOrEqual(1);
    expect(pausedRows.map((d) => d.track)).toEqual(pausedRows.map(() => 'b'));
    expect(ended(rows)).toBe(false);
    expect(cards).toHaveLength(1);                                                 // the failed branch alone has a card
    expect((cards[0] as any).title).toContain('Broken branch');
    // The reason in the pause row (a subagent step says: stopped before it answered (<why>); Resume runs it on) and the same line told to the user.
    expect(pausedRows[0]).toMatchObject({ reason: 'stop', stepId: 'b' });
    const reason = /(?:stopped before it answered|reply was an error) \(.{3,}\); Resume runs it on/.exec(String(pausedRows[0]!.text));
    expect(asText(rows)).toContain(String(pausedRows[0]!.text).slice(0, 40));
    expect(String(pausedRows[0]!.text).length).toBeLessThan(400);
    expect(reason, 'a readable reason with the branch in it: ' + String(pausedRows[0]!.text).slice(0, 300)).toBeTruthy();
    const procsBefore = processes().filter((p) => !base.has(p.pid) && p.claude);

    const t0 = Date.now();
    expect((await w.stop(s)).status).toBe(200);
    await w.pump(s, () => { const r = since(w, s, first.mark); return ended(r) && r.some((x) => x.type === 'receipt') && w.rows(s).at(-1)?.type === 'status'; }, handler, REAL ? 90_000 : 15_000);
    const stopMs = Date.now() - t0;
    const end = since(w, s, first.mark);
    expect(end.some((r) => r.type === 'run_stopped')).toBe(true);
    expect(end.some((r) => r.type === 'run_finished')).toBe(false);
    expect(datas(end, 'fork_done')).toEqual([]);
    expect(openQuestions(w.rows(s))).toEqual([]);
    expect(stopMs).toBeLessThan(REAL ? 30_000 : 5_000);
    const left = await noneLeft(base, 15_000);
    expect(namesOf(left)).toBe('none');
    note(w, {
      row: `M3-2 fork with a failed branch (${REAL ? 'API + claude CLI with an unknown model' : 'fake + fake with a 404'})`, pass: true,
      counts: {
        branchAEnded: true, forkDone: 0, finalTurns: 0, pauseRowsOfOtherTracks: 0, resumeCardsOpen: cards.length, reason: JSON.stringify((reason?.[0] ?? '').slice(0, 160)),
        stopToEndMs: stopMs, runEnded: 'run_stopped', openQuestionsAfter: 0, newClaudeProcessesDuringRun: procsBefore.length, processesLeftAfter: namesOf(left),
      },
      notes: [`branch b asked the model ${bogus}, which its provider does not have`],
    });
  }, LONG);
});

// ---- rows 3 and 4: the playbook

const GREET = '---\nreins: 1\nblock: greet\n---\n\n## phase Hello\nid: hello\n> Say hello to {{who}} in one short sentence.\n\n## run `echo hi {{who}}`\nid: say\n';
const writeGreet = (w: World) => { fs.mkdirSync(path.join(w.proj, 'blocks'), { recursive: true }); fs.writeFileSync(path.join(w.proj, 'blocks', 'greet.reins.md'), GREET); };

liveSuite('M3 row 3: an inline playbook with an input', { key: 'anthropic' }, () => {
  let w: World;
  beforeAll(async () => {
    w = await startWorld({ provider: 'anthropic', model: MODEL, budget: CAPS.inline });
    await w.consent();
    writeGreet(w);
  }, LONG);
  afterAll(async () => { await w?.close(); }, LONG);

  it('the steps run prefixed, the input is in the prompt the engine saw, and the trust list holds the command the input made (and its hash follows the input)', async () => {
    w.script({ text: 'Hello Ann!', usage: tokens(900, 8) });
    const flow = (who: string) => `${HEAD('playbook-inline', CAPS.inline)}## playbook greet\nid: pb\ninput: who=${who}\n\n## end\n`;
    const file = path.join(w.proj, 'playbook-inline.reins.md');
    const s = await w.session();
    const asked: Array<{ kind: string; detail: string }> = [];
    const handler: Handler = (q, rows) => { if (q.kind === 'trust') asked.push({ kind: q.kind, detail: String(q.detail ?? '') }); return allowAll(q, rows); };
    const run = await go(w, s, 'playbook-inline', flow('Ann'), handler);
    const rows = run.rows;

    expect(rows.some((r) => r.type === 'run_finished')).toBe(true);
    // The steps of the file run under the playbook's id.
    const stepIds = datas(rows, 'step_started').map((d) => String(d.step));
    expect(stepIds).toContain('pb/hello');
    expect(stepIds).toContain('pb/say');
    expect(stepIds.filter((x) => x.startsWith('pb/') || x === 'pb')).not.toContain('hello');
    expect(datas(rows, 'playbook_started')).toEqual([{ step: 'pb', playbook: 'greet', session: 'inline' }]);
    expect(datas(rows, 'playbook_done')).toEqual([{ step: 'pb', playbook: 'greet' }]);
    expect(datas(rows, 'track_started')).toEqual([]);                              // inline: no track, no session of its own
    expect(mainTurns(rows, 'pb/hello')).toHaveLength(1);

    // The input is in the prompt the engine saw, and no placeholder was left.
    const sent = convoText(w, s);
    expect(sent).toContain('Say hello to Ann in one short sentence.');
    expect(sent).not.toContain('{{who}}');
    if (!REAL) expect(JSON.stringify(w.fake!.requests.map((r) => r.body))).toContain('Say hello to Ann');

    // The trust list: the question the run asked held the command made from the input; the hash is of exactly that list.
    const trust = asked.find((a) => a.detail.includes('echo hi Ann'));
    expect(trust, JSON.stringify(asked.map((a) => a.detail.slice(0, 80)))).toBeTruthy();
    const hashOf = (who: string) => { fs.writeFileSync(file, flow(who)); const l = loadWorkflowText(fs.readFileSync(file, 'utf8'), file); expect(l.workflow, JSON.stringify(l.diagnostics)).toBeTruthy(); const cmds = commandsOf(l.workflow!, l.resolveBlock); return { cmds, hash: hashCommands(cmds) }; };
    const ann = hashOf('Ann');
    expect(trust!.detail.split('\n')).toEqual(ann.cmds);
    expect(w.store.isTrusted(w.proj, file, ann.hash)).toBe(true);                  // the yes of the run was recorded under this hash
    const bob = hashOf('Bob');                                                     // the same file with another input
    expect(bob.cmds).toContain('echo hi Bob');
    expect(bob.hash).not.toBe(ann.hash);
    expect(w.store.isTrusted(w.proj, file, bob.hash)).toBe(false);                 // so it would ask again
    // An input that carries a second command is in the list whole, as one command (this file is only read, never run).
    const evil = hashOf('Ann && echo injected');
    expect(evil.cmds).toContain('echo hi Ann && echo injected');
    expect(evil.hash).not.toBe(ann.hash);
    const reply = mainTurns(rows, 'pb/hello')[0]!.text;
    note(w, {
      row: `M3-3 inline playbook with an input (${REAL ? 'Haiku 5.5 on the API' : 'fake'})`, pass: true,
      counts: {
        stepIds: JSON.stringify(stepIds.filter((x) => x.startsWith('pb'))), playbookStarted: 1, playbookDone: 1, tracks: 0, trustListed: JSON.stringify(ann.cmds), hashChangesWithInput: true,
        injectedCommandListed: true, replyMentionsAnn: String(reply).includes('Ann'), receiptTotalUsd: run.receipt.totalCostUsd, ownCountUsd: Number(w.budget.spent.toFixed(6)),
      },
      notes: [`price: ${w.priceNote(MODEL)}`],
    });
  }, LONG);
});

liveSuite('M3 row 4: a playbook with session: own and a USD cap', { key: 'anthropic' }, () => {
  let w: World;
  let base: Set<number>;
  beforeAll(async () => {
    base = baselineOf();
    w = await startWorld({ provider: 'anthropic', model: MODEL, budget: CAPS.own });
    await w.consent();
    writeGreet(w);
  }, LONG);
  afterAll(async () => { await w?.close(); }, LONG);

  it('runs as a track with its own session, the cap is held, the receipt has its row, and the line after it gets its result', async () => {
    const CAP = 0.05;
    w.script({ text: 'Hello Ann!', usage: tokens(900, 8) }, { text: 'The playbook said hello to Ann.', usage: tokens(1100, 10) });
    const text = `${HEAD('playbook-own', CAPS.own)}## playbook greet\nid: pb\ninput: who=Ann\nsession: own\nusd: ${CAP}\n\n## phase After\nid: after\n> Say in one short sentence what the playbook result above says.\n\n${END}`;
    const s = await w.session();
    const run = await go(w, s, 'playbook-own', text, allowAll);
    const rows = run.rows;

    expect(rows.some((r) => r.type === 'run_finished')).toBe(true);
    expect(datas(rows, 'track_started')).toEqual([{ track: 'pb#own', parent: '', group: 'pb', title: 'Playbook greet' }]);
    expect(datas(rows, 'track_ended').map((d) => d.track)).toEqual(['pb#own']);
    expect(datas(rows, 'playbook_started')).toEqual([{ step: 'pb', playbook: 'greet', session: 'own' }]);
    expect(datas(rows, 'playbook_done')).toEqual([{ step: 'pb', playbook: 'greet' }]);
    // Its steps ran in the track, under the playbook's id; the main line only ran the line after it.
    expect(datas(rows, 'turn_ended').filter((d) => d.track === 'pb#own').map((d) => d.step)).toEqual(['pb/hello']);
    expect(mainTurns(rows, 'after')).toHaveLength(1);
    expect(mainTurns(rows, 'pb/hello')).toEqual([]);
    // A session of its own, and not the main line's.
    const mainId = w.store.getSession(s)!.engineSessionId;
    const own = run.ids.get('track pb#own');
    expect(own, JSON.stringify([...run.ids.keys()])).toBeTruthy();
    expect(own).not.toBe(mainId);
    expect(convoText(w, s)).toContain('Result of Playbook greet (step pb)');       // the result was handed to the line after it, and the input made the prompt
    // The cap is held and the receipt has the row.
    const tracks = run.receipt.tracks as TrackRow[];
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ key: 'pb#own', title: 'Playbook greet', ended: true, turns: 1 });
    expect(tracks[0]!.usd).toBeGreaterThan(0);
    expect(tracks[0]!.usd).toBeLessThanOrEqual(CAP);
    expect(rows.some((r) => r.type === 'budget_reached' || r.type === 'budget_warning')).toBe(false);
    expect(datas(rows, 'turn_ended').filter((d) => d.track === 'pb#own').reduce((a, d) => a + Number(d.cost ?? 0), 0)).toBeLessThanOrEqual(CAP);
    const after = Number(mainTurns(rows, 'after')[0]!.cost ?? 0);
    expect(near(tracks[0]!.usd + after, run.receipt.totalCostUsd)).toBe(true);
    expect(near(run.receipt.totalCostUsd, w.budget.spent)).toBe(true);
    const left = await noneLeft(base, 15_000);
    expect(namesOf(left)).toBe('none');
    note(w, {
      row: `M3-4 playbook session: own, usd ${CAP} (${REAL ? 'Haiku 5.5 on the API' : 'fake'})`, pass: true,
      counts: { capUsd: CAP, trackUsd: tracks[0]!.usd, trackTurns: tracks[0]!.turns, afterTurnUsd: after, receiptTotalUsd: run.receipt.totalCostUsd, ownCountUsd: Number(w.budget.spent.toFixed(6)), trackSessionDiffersFromMain: true, processesLeft: namesOf(left) },
      notes: [`price: ${w.priceNote(MODEL)}`],
    });
  }, LONG);
});

// ---- row 5: the envelope between two homes

const j = (m: unknown) => JSON.stringify(m, null, 2);
const TAG_ID = 'm3tag';
const DATA_ID = 'm3data';
const tagFiles = (): Record<string, string> => ({
  'mod.json': j({
    reins: 1, id: TAG_ID, kind: 'block', version: '1.0.0', label: 'M3 tag', main: 'index.js', order: 170,
    provides: { kinds: [TAG_ID], ops: ['OP_M3TAG'], attrs: ['times'], events: ['m3tagran'] },
    view: { kind: TAG_ID, order: 170, colour: 'soft', fields: [{ key: 'times', label: 'Times', input: 'number', check: 'count' }], line: [TAG_ID, { field: 'times' }], card: { label: TAG_ID, section: 'Flow' }, fresh: { attrs: { times: '1' } } },
  }),
  'index.js': `export default function activate(api) {
  api.registerBlock({ kind: '${TAG_ID}', attrs: ['times'], compile(step, ctx) { ctx.push({ op: 'OP_M3TAG', step: step.id }); },
    ops: { OP_M3TAG: { async exec(i, vm) { vm.log('m3tagran', { step: i.step }); vm.next(); } } } });
}
`,
});
/** A mod with no code: a provider that only names a protocol Reins has. */
const dataFiles = (): Record<string, string> => ({
  'mod.json': j({ reins: 1, id: DATA_ID, kind: 'provider', version: '1.0.0', label: 'M3 data', protocol: 'openai-chat', baseUrl: 'https://example.invalid/v1', auth: { style: 'none', keyEnv: [] }, defaultModel: 'm-1', models: [{ id: 'm-1', label: 'M1', context: 100000, maxOutput: 4000, tools: true }] }),
});
/** Writes the mods into `<dir>/mods` and trusts the code one the way the trust file does (the hash of its files). */
function installTagAndData(dir: string) {
  for (const [id, files] of [[TAG_ID, tagFiles()], [DATA_ID, dataFiles()]] as const) {
    const folder = path.join(dir, 'mods', id);
    fs.mkdirSync(folder, { recursive: true });
    for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(folder, n), t);
  }
  const file = path.join(dir, 'mod-trust.json');
  fs.writeFileSync(file, JSON.stringify({ [TAG_ID]: hashFiles(readFolder(path.join(dir, 'mods', TAG_ID), TAG_ID)) }));
}
/** Every file under a folder, as { relative path: text }; a folder is a key too. Equal before and after means nothing was written, moved or left behind. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).replaceAll('\\', '/');
      if (e.isDirectory()) { out[`${rel}/`] = 'dir'; walk(p); } else out[rel] = fs.readFileSync(p, 'utf8');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

liveSuite('M3 row 5: an envelope of a code mod, a data mod and a workflow, from one home into a fresh one', { key: 'anthropic' }, () => {
  let w1: World;
  let w2: World;
  beforeAll(async () => {
    w1 = await startWorld({ provider: 'anthropic', model: MODEL, budget: CAPS.envelope, prepare: ({ dir }) => installTagAndData(dir) });
    w2 = await startWorld({ provider: 'anthropic', model: MODEL, budget: CAPS.envelope });
    await w2.consent();
  }, LONG);
  // The harness wraps stdout in order; the second world is closed first so that the first puts it back as it was.
  afterAll(async () => { await w2?.close(); await w1?.close(); }, LONG);

  it('one summary, trust for the code mod only, the workflow saved, the run works; a changed code file asks for trust again', async () => {
    const wfText = `${HEAD('share', CAPS.envelope)}## ${TAG_ID}\nid: tag\ntimes: 2\n\n## phase One\nid: one\n> Reply with exactly one short sentence.\n\n${END}`;
    w2.script({ text: 'This is the one sentence.', usage: tokens(900, 8) });

    // Export from home 1 to a file.
    const out = await w1.api('POST', '/api/mods/bundle', { ids: [TAG_ID, DATA_ID], workflow: { name: 'share', text: wfText } });
    expect(out.status, out.text.slice(0, 300)).toBe(200);
    expect(out.json.ids).toEqual([DATA_ID, TAG_ID]);
    const file = path.join(w1.root, 'share.reins-mods.json');
    fs.writeFileSync(file, out.json.text as string);
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8')) as { reinsMods: number; mods: Record<string, Record<string, string>>; workflow: { name: string; text: string } };
    expect(Object.keys(envelope.mods).sort()).toEqual([DATA_ID, TAG_ID]);
    expect(envelope.workflow.text).toBe(wfText);
    expect(Object.keys(envelope.mods[TAG_ID]!).sort()).toEqual(['index.js', 'mod.json']);   // no trust file, no key: the mod's own files

    // Home 2 is fresh: nothing of it is there.
    const fresh = snapshot(w2.dir);
    expect(fresh[`mods/${TAG_ID}/mod.json`]).toBeUndefined();
    expect(fresh['mod-trust.json']).toBeUndefined();

    // ONE summary: one answer for both mods, the prompt for the code mod only.
    const text = fs.readFileSync(file, 'utf8');
    const pre = await w2.api('POST', '/api/mods/import/preview', { file: text });
    expect(pre.status, pre.text.slice(0, 300)).toBe(200);
    const sum = pre.json.summary;
    expect(sum.envelope).toBe(true);
    expect((sum.mods as Array<{ id: string }>).map((m) => m.id).sort()).toEqual([DATA_ID, TAG_ID]);
    const tag = (sum.mods as any[]).find((m) => m.id === TAG_ID);
    const data = (sum.mods as any[]).find((m) => m.id === DATA_ID);
    expect(tag).toMatchObject({ hasCode: true, trusted: false, codePrompt: CODE_PROMPT });
    expect(typeof tag.hash).toBe('string');
    expect(data.hasCode).toBe(false);
    expect(data.codePrompt).toBeUndefined();
    expect(data.hash).toBeUndefined();
    expect(sum.workflow).toMatchObject({ name: 'share', exists: false, diagnostics: [] });
    expect(sum.adds.join('\n')).toContain(TAG_ID);
    expect(snapshot(w2.dir)).toEqual(fresh);                                       // the preview wrote nothing

    // Refusals that leave the home as it was: trusting a mod that has no code, trusting the wrong code.
    const noCode = await w2.api('POST', '/api/mods/import', { file: text, trust: { [DATA_ID]: 'x' } });
    expect(noCode.status).toBe(400);
    const wrongHash = await w2.api('POST', '/api/mods/import', { file: text, trust: { [TAG_ID]: 'not-the-hash' } });
    expect(wrongHash.status).toBe(409);
    expect(snapshot(w2.dir)).toEqual(fresh);

    // The import: one trust choice, for the code mod, by the hash that was shown.
    const done = await w2.api('POST', '/api/mods/import', { file: text, trust: { [TAG_ID]: tag.hash } });
    expect(done.status, done.text.slice(0, 300)).toBe(200);
    expect(done.json.trust).toEqual({ [TAG_ID]: 'trusted' });                      // a status for the code mod only
    expect(done.json.reloaded).toBe(true);
    expect(done.json.workflow).toMatchObject({ name: 'share', diagnostics: [] });
    const saved = path.join(w2.dir, 'workflows', 'share.reins.md');
    expect(fs.readFileSync(saved, 'utf8')).toBe(wfText);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(w2.dir, 'mod-trust.json'), 'utf8')))).toEqual([TAG_ID]);
    for (const n of Object.keys(envelope.mods[TAG_ID]!)) expect(fs.readFileSync(path.join(w2.dir, 'mods', TAG_ID, n), 'utf8')).toBe(envelope.mods[TAG_ID]![n]);
    expect(fs.existsSync(path.join(w2.dir, 'mods', DATA_ID, 'mod.json'))).toBe(true);

    // The workflow runs there, and the block of the imported code mod ran.
    const s = await w2.session();
    const run = await go(w2, s, 'share', '', allowAll, { file: saved });
    expect(run.rows.some((r) => r.type === 'run_finished')).toBe(true);
    expect(datas(run.rows, 'm3tagran')).toEqual([{ step: 'tag' }]);
    expect(mainTurns(run.rows, 'one')).toHaveLength(1);

    // A changed code file asks again: the hash differs, it is not trusted, and the hash that was trusted before opens nothing.
    const tampered = JSON.parse(text) as typeof envelope;
    tampered.mods[TAG_ID]!['index.js'] += '\n// changed by someone on the way\n';
    tampered.workflow = { name: 'share-again', text: wfText };                     // another name, so that "already saved" cannot be what refuses it
    const bad = JSON.stringify(tampered);
    const before = snapshot(w2.dir);
    const pre2 = await w2.api('POST', '/api/mods/import/preview', { file: bad });
    expect(pre2.status).toBe(200);
    const tag2 = (pre2.json.summary.mods as any[]).find((m) => m.id === TAG_ID);
    expect(tag2.hash).not.toBe(tag.hash);
    expect(tag2.trusted).toBe(false);
    expect(tag2.codePrompt).toBe(CODE_PROMPT);
    const old = await w2.api('POST', '/api/mods/import', { file: bad, trust: { [TAG_ID]: tag.hash } });
    expect(old.status).toBe(409);
    expect(old.text).toContain('not the code you were shown');
    expect(snapshot(w2.dir)).toEqual(before);                                      // nothing was installed, nothing was changed
    expect(fs.existsSync(path.join(w2.dir, 'workflows', 'share-again.reins.md'))).toBe(false);

    const a = w1.sweepAll();
    const b = w2.sweepAll();
    const swept: SweepResult = { files: a.files + b.files, unreadable: a.unreadable + b.unreadable, hits: [...a.hits, ...b.hits] };
    expect(swept.hits).toEqual([]);
    record({
      row: `M3-5 envelope round trip between two homes (${REAL ? 'Haiku 5.5 on the API for the one turn' : 'fake'})`, model: MODEL, pass: true, cost: w2.budget.spent, swept,
      counts: {
        modsInFile: 2, summaries: 1, codeModsToTrust: 1, codePromptShown: true, trustAnswer: JSON.stringify(done.json.trust), workflowSaved: true, previewWroteNothing: true,
        wrongHashStatus: wrongHash.status, trustOnNoCodeModStatus: noCode.status, ranThere: true, m3tagranRows: 1, tamperedHashDiffers: true, tamperedTrustedBefore: false, oldHashOnTamperedStatus: old.status, homeAfterRefusal: 'unchanged',
        receiptTotalUsd: run.receipt.totalCostUsd,
      },
      notes: ['both homes are in-process worlds of the harness, talked to over their real HTTP routes (POST /api/mods/bundle, /api/mods/import/preview, /api/mods/import); home 2 started with no mod, no trust file and no workflow'],
    }, { secrets: [w1.key, w2.key], ...(EVIDENCE ? { file: EVIDENCE } : {}) });
  }, LONG);
});

// ---- row 6: the server is a separate process, killed hard in the middle of a fork

interface Child { proc: ChildProcess; port: number; token: string; out: string[]; dead: Promise<void> }
/** A hard kill: taskkill on Windows, SIGKILL elsewhere (of the whole process group when `tree`; the server is spawned as a group leader off Windows). */
function hardKill(pid: number | undefined, tree: boolean): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(pid), '/F', ...(tree ? ['/T'] : [])], { stdio: 'ignore' }); } catch { /* already gone */ } return; }
  try { process.kill(tree ? -pid : pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
}
const killTree = (c: Child) => hardKill(c.proc.pid, true);
const isLive = (c: Child) => c.proc.exitCode === null && c.proc.signalCode === null;

interface Home { root: string; dir: string; proj: string; key: string; keyVar: string; env: NodeJS.ProcessEnv }
function makeHome(baseUrl: string): Home {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-m3k-')));
  const dir = path.join(root, '.reins');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(dir, 'mods', 'anthropic'), { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  const spec = PROVIDERS.anthropic;
  const key = REAL ? process.env[spec.keyVar] || spec.shape() : spec.shape();
  const m = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, 'anthropic', 'mod.json'), 'utf8')) as Record<string, any>;
  m.auth = { ...m.auth, keyEnv: [spec.keyVar] };
  delete m.catalog;
  if (!REAL) m.baseUrl = baseUrl;
  for (const x of m.models as Array<{ id: string; price?: unknown }>) if (x.id === MODEL && !x.price) x.price = ASSUMED;
  fs.writeFileSync(path.join(dir, 'mods', 'anthropic', 'mod.json'), JSON.stringify(m, null, 2));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^REINS_/i.test(k) && !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k)) env[k] = v;
  env[spec.keyVar] = key;
  env.REINS_HOME = root;
  return { root, dir, proj, key, keyVar: spec.keyVar, env };
}

/** `reins serve` from the built package, as a separate process; resolves with its address. */
async function startChild(h: Home): Promise<Child> {
  const proc = spawn(process.execPath, [DIST_CLI, 'serve', '--port', '0'], { cwd: h.root, env: h.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
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

// Each branch's turn parks on a tool approval: a turn that is open, in flight, and still there when the server dies. The branch titles do not hold the BRANCH marks.
const FORK_FLOW = (name: string) => `${HEAD(name, CAPS.kill)}## fork\nid: f\nnext: a\nnext: b\n\n`
  + `## phase After\nid: after\n> Write one short sentence that contains both words the two branch results gave.\n\n${END}`
  + `## phase Alpha branch\nid: a\n> BRANCH-A: Use the ${SHELL} tool to run exactly this command: Write-Output a-done\nThen reply with exactly the single word ALPHA.\n\n${END}`
  + `## phase Bravo branch\nid: b\n> BRANCH-B: Use the ${SHELL} tool to run exactly this command: Write-Output b-done\nThen reply with exactly the single word BRAVO.\n\n${END}`;

describe.skipIf(!fs.existsSync(DIST_CLI) || (REAL && !process.env[PROVIDERS.anthropic.keyVar]))('M3 row 6: restore mid-fork after the server process was killed', () => {
  const homes: Home[] = [];
  const children: Child[] = [];
  const fakes: Array<{ close(): Promise<unknown> }> = [];
  afterEach(async () => {
    for (const c of children.splice(0)) { if (isLive(c)) killTree(c); await c.dead; }
    for (const f of fakes.splice(0)) await f.close();
    for (const h of homes.splice(0)) { try { fs.rmSync(h.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* left for the OS temp cleaner */ } }
  }, LONG);

  const trustAndTools: Handler = (q) => (q.kind === 'trust' ? 'y' : q.kind === 'tool' ? undefined : q.kind === 'switch' ? 'n' : 'stop');
  const yes: Handler = (q) => (q.kind === 'trust' || q.kind === 'tool' ? 'y' : q.kind === 'switch' ? 'n' : 'stop');
  const tool = (name: string, id: string) => ({ ...call(SHELL, { command: `Write-Output ${name}` }, id), usage: tokens(1200, 30) });

  it('the fork does not run twice: fork_done once, the turn after the fork once, each branch answered once, nothing billed twice', async () => {
    let a: Fake | undefined;
    let b: Fake | undefined;
    let url = '';
    if (!REAL) {
      a = await startFakeProvider({ strictPairs: true });
      b = await startFakeProvider({ strictPairs: true });
      const router = await startRouter(a, b);
      fakes.push(a, b, router);
      url = router.url;
    }
    const h = makeHome(url);
    homes.push(h);
    a?.push(tool('a-done', 'toolu_a'));
    b?.push(tool('b-done', 'toolu_b'));
    const reqs = () => (a?.requests.filter((r) => r.path.endsWith('/messages')).length ?? 0) + (b?.requests.filter((r) => r.path.endsWith('/messages')).length ?? 0);

    // Server 1: start the fork, wait until both branches have a tool card open (a turn in flight in each), kill the process.
    const c1 = await startChild(h);
    children.push(c1);
    const consent = await api(c1, 'POST', '/api/mods/anthropic/consent', { origin: new URL(REAL ? 'https://api.anthropic.com' : url).origin });
    expect(consent.status).toBe(200);
    const made = await api(c1, 'POST', '/api/sessions', { cwd: h.proj, engine: 'anthropic', model: MODEL });
    expect(made.status).toBe(200);
    const sid = made.json.id as string;
    const flow = path.join(h.proj, 'kill-fork.reins.md');
    fs.writeFileSync(flow, FORK_FLOW('kill-fork'));
    expect((await api(c1, 'POST', `/api/sessions/${sid}/run`, { path: flow })).status).toBe(200);
    const pre = await pumpChild(c1, sid, (r) => ['a', 'b'].every((k) => openQuestions(r).some((q) => q.kind === 'tool' && q.owner === k)), trustAndTools, REAL ? 240_000 : 20_000);
    const rid = pre.find((r) => r.runId)!.runId!;
    expect(datas(pre, 'fork_started')).toHaveLength(1);
    expect(datas(pre, 'fork_done')).toEqual([]);
    expect(datas(pre, 'turn_ended')).toEqual([]);                                  // both branches are mid-turn: no turn has ended
    const costBefore = convoCost(h.dir);
    const sentBefore = reqs();
    killTree(c1);                                                                  // a hard kill: no clean close, no detach
    await c1.dead;
    expect(isLive(c1)).toBe(false);

    // Server 2 on the same home: the run reads as detached; Resume restores it and it finishes.
    a?.push(tool('a-done', 'toolu_a2'), { text: 'ALPHA', usage: tokens(1400, 5) }, { text: 'ALPHA and BRAVO.', usage: tokens(1800, 10) });
    b?.push(tool('b-done', 'toolu_b2'), { text: 'BRAVO', usage: tokens(1400, 5) });
    const c2 = await startChild(h);
    children.push(c2);
    const afterRestart = await logOf(c2, sid);
    expect(afterRestart.some((r) => r.type === 'run_detached' && r.runId === rid)).toBe(true);
    expect(openQuestions(afterRestart)).toEqual([]);
    expect((await api(c2, 'POST', `/api/sessions/${sid}/resume`, { runId: rid })).status).toBe(200);
    const t0 = Date.now();
    const rows = await pumpChild(c2, sid, (r) => r.some((x) => x.type === 'receipt' && x.runId === rid), yes, REAL ? 240_000 : 20_000);
    const ms = Date.now() - t0;

    expect(rows.some((r) => r.type === 'run_finished' && r.runId === rid)).toBe(true);
    // The fork ran once: one start, one done, two tracks started once each, and ended once each.
    expect(datas(rows, 'fork_started')).toHaveLength(1);
    expect(datas(rows, 'fork_done')).toHaveLength(1);
    expect(datas(rows, 'track_started').map((d) => d.track).sort()).toEqual(['a', 'b']);
    expect(datas(rows, 'track_ended').map((d) => d.track).sort()).toEqual(['a', 'b']);
    // Each step answered exactly once, and the turn after the fork once.
    const turns = datas(rows, 'turn_ended').map((d) => `${d.track ?? 'main'}/${d.step}`).sort();
    expect(turns).toEqual(['a/a', 'b/b', 'main/after']);
    expect(datas(rows, 'turn_started').filter((d) => d.step === 'after')).toHaveLength(1);
    if (!REAL) expect(reqs() - sentBefore).toBe(5);                                // both branches again (the tool call), their answers after the tool ran, and the one turn after the fork

    // Money: the receipt is every turn once; not above the Budget's own count of the conversation files, and not below it by more than the calls the kill cut off.
    const receipt = rows.find((r) => r.type === 'receipt' && r.runId === rid)!.data as any;
    const eachTurn = datas(rows, 'turn_ended').reduce((x, d) => x + Number(d.cost ?? 0), 0);
    const own = convoCost(h.dir);
    expect(near(receipt.totalCostUsd, eachTurn)).toBe(true);
    expect(receipt.totalCostUsd).toBeLessThanOrEqual(own + NEAR);
    const lost = own - receipt.totalCostUsd;
    expect(lost).toBeLessThan(REAL ? 0.02 : 0.003);
    expect(own).toBeLessThan(CAPS.kill);
    const trackSum = (receipt.tracks as Array<{ usd: number }>).reduce((x, t) => x + t.usd, 0);
    const afterCost = Number(datas(rows, 'turn_ended').find((d) => d.step === 'after')!.cost ?? 0);
    expect(near(trackSum + afterCost, receipt.totalCostUsd)).toBe(true);
    expect(receipt.counts).toMatchObject({ forks: 1 });

    const swept = sweep(h.root, h.key, [{ name: 'server output 1', text: c1.out.join('') }, { name: 'server output 2', text: c2.out.join('') }]);
    expect(swept.hits).toEqual([]);
    record({
      row: `M3-6 restore mid-fork after a hard server kill (${REAL ? 'Haiku 5.5 on the API' : 'fake'})`, model: MODEL, pass: true, cost: own, swept,
      counts: {
        forkStarted: 1, forkDone: 1, trackStarted: 2, trackEnded: 2, stepsAnswered: JSON.stringify(turns), afterTurnStarted: 1, turnsEndedBeforeKill: 0, costBeforeKillUsd: Number(costBefore.toFixed(6)),
        requestsAfterResume: REAL ? 'n/a' : reqs() - sentBefore, resumeToEndMs: ms, receiptTotalUsd: receipt.totalCostUsd, sumOfTurnCostsUsd: Number(eachTurn.toFixed(6)), ownCountUsd: Number(own.toFixed(6)),
        cutOffCallsUsd: Number(lost.toFixed(6)), trackUsd: JSON.stringify((receipt.tracks ?? []).map((t: any) => [t.key, t.usd])),
      },
      notes: ['the server was killed with taskkill /F /T while both branches had a tool card open (a turn in flight in each); the second process was started on the same home and the run resumed through POST /resume'],
    }, { secrets: [h.key], ...(EVIDENCE ? { file: EVIDENCE } : {}) });
  }, LONG);
});
