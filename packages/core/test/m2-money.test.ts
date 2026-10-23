// M2 task 12: money. Tracks that start with `share: true` split the USD room; the next process of a track is capped at `share - spent`; a reply cut off at
// the share is no reply (the instruction runs again and sends CARRY_ON); free room is taken by the track that ran out, less than a cent is the one run-wide
// card; an Allow gives every live track a new share; a loop branch is capped by its live room. The USD pause names the track, and an Allow on a track's own
// inherited slice raises that track only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { validate } from '../src/validate.js';
import { Run, trackSpendKey, type RunOptions, type RunSnapshot, type SubagentOpen, type SubagentOpened } from '../src/run.js';
import { register } from '../src/nodes/index.js';
import { USD_UNKNOWN } from '../src/display.js';
import type { ScriptedTurn } from '../src/fake-engine.js';
import type { Workflow } from '../src/model.js';
import { m2harness } from './m2-harness.js';
import { split } from './fixtures/split.js';
import { ssplit } from './fixtures/split-share.js';

const disposers: Array<() => void> = [];
beforeAll(() => { disposers.push(register(split), register(ssplit)); });
afterAll(() => { for (const d of disposers.splice(0).reverse()) d(); });

const wf = (body: string, budget = 'turns: 40, minutes: 60'): Workflow => {
  const r = parseWorkflow(`---\nreins: 1\nname: t\nbudget: { ${budget} }\nalways: []\n---\n\n${body}\n`);
  expect(r.diagnostics).toEqual([]);
  expect(validate(r.workflow!).filter((d) => d.severity === 'error')).toEqual([]);
  return r.workflow!;
};
type Harness = ReturnType<typeof m2harness>;
const usdB = (usd: number, turns = 40) => `turns: ${turns}, minutes: 60, usd: ${usd}`;
const mk = (h: Harness, body: string, budget?: string, opts: Partial<RunOptions> = {}) =>
  new Run({ workflow: wf(body, budget), engine: h.engine, openSubagent: h.openSubagent, now: h.now, ...opts });
const reply = (text: string, cost: number): ScriptedTurn => ({ text: `${text}\nREINS: done`, cost });
/** A reply the provider cut off at its cap: an error, with the money it cost. The words say `fail`, so a verify that counted it would log a failure. */
const cut = (cost: number): ScriptedTurn => ({ text: 'cut\nREINS: fail', cost, isError: true });
const mainOf = (s: string) => `${s}-main-1`;
const subOf = (s: string, key: string) => `${s}-sub-${key}`;
const drive = (run: Run) => (async () => { for (let k = 0; k < 60 && run.status === 'running'; k++) await run.step(); })();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean) => { for (let k = 0; k < 400 && !f(); k++) await sleep(5); expect(f()).toBe(true); };
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => 'timeout' as const)]);
const named = (run: Run, type: string) => run.getEvents().filter((e) => e.type === type);
const ended = (run: Run, key: string) => named(run, 'track_ended').some((e) => e.data.track === key);
const opensOf = (h: Harness, key: string) => h.subagentOpens.filter((o) => o.step === key);
/** What the tests read of a Run that is private. */
const inner = (r: Run) => r as unknown as {
  pauseUsd(t: unknown, s: unknown, limit: number, spent: number, text?: string): true;
  usdRoom(t: unknown): number | undefined;
};

const A_PHASE = '## phase a\n> a\n\n## end';
const A_VERIFY = '## phase a\n> a\n\n## verify\nagainst: a\n\n## end';
const B_PHASE = '## phase b\n> b\n\n## end';
const C_PHASE = '## phase c\n> c\n\n## end';
/** The main line spends first (step `pre`), then a split of three that share the room. */
const THREE = (a = A_PHASE, pre = '## phase pre\n> p\n\n') =>
  `${pre}## ssplit\nnext: a\nnext: b\nnext: c\n\n## phase main\n> m\n\n## end\n\n${a}\n\n${B_PHASE}\n\n${C_PHASE}`;

describe('the room is shared in equal parts at start', () => {
  it('1: workflow $1.00 with $0.10 spent, a split of three: each session is capped at 0.30', async () => {
    const h = m2harness('M1');
    h.script(mainOf('M1'), reply('p', 0.1));
    const run = mk(h, THREE(), usdB(1));
    await drive(run);
    expect(run.status).toBe('done');
    expect(['a', 'b', 'c'].map((k) => opensOf(h, k)[0]!.maxUsd)).toEqual([0.3, 0.3, 0.3]);
    await run.close();
  });

  it('2: a $0.50 slice before a split of three, no workflow limit: 0.166667 each (rounded up as a cap is); with $0.30 left in the workflow too: 0.10 each', async () => {
    const h = m2harness('M2');
    const run = mk(h, '## model claude-x\nusd: 0.5\n\n' + THREE(A_PHASE, ''));
    await drive(run);
    expect(['a', 'b', 'c'].map((k) => opensOf(h, k)[0]!.maxUsd)).toEqual([0.166667, 0.166667, 0.166667]);
    await run.close();

    // the workflow allows 0.80 and 0.50 of it is spent before the slice opens: 0.30 left, less than the slice's 0.50
    const g = m2harness('M2w');
    g.script(mainOf('M2w'), reply('p', 0.5));
    const both = mk(g, '## phase pre\n> p\n\n## model claude-x\nusd: 0.5\n\n' + THREE(A_PHASE, ''), usdB(0.8));
    await drive(both);
    expect(['a', 'b', 'c'].map((k) => opensOf(g, k)[0]!.maxUsd)).toEqual([0.1, 0.1, 0.1]);
    await both.close();
  });

  it('3: a track that spent 0.12 of 0.30 reopens with 0.18, not total plus share', async () => {
    const h = m2harness('M3');
    h.script(subOf('M3', 'a'), { text: '', reject: 'boom', paid: { cost: 0.12, total: 0.12 } });
    const reopen = async (x: SubagentOpen) => { if (x.sessionId) h.script(x.sessionId, reply('a', 0)); return h.openSubagent(x); };   // a reopened session is a new fake: its own list
    const run = mk(h, THREE(), usdB(0.9), { openSubagent: reopen });
    const driven = drive(run);
    await until(() => run.tracks.get('a')?.state === 'paused');
    expect(opensOf(h, 'a')[0]!.maxUsd).toBe(0.3);
    run.resume('a');
    await until(() => opensOf(h, 'a').length === 2);
    expect(opensOf(h, 'a')[1]!.maxUsd).toBe(0.18);
    expect(await within(driven, 3000)).toBeUndefined();
    await run.close();
  });

  it('12: no workflow limit and no open slice: no cap and no room on a track session', async () => {
    const h = m2harness('M12');
    const run = mk(h, THREE());
    await drive(run);
    expect(run.status).toBe('done');
    for (const o of h.subagentOpens) { expect(o.maxUsd).toBeUndefined(); expect(o.usdRoom).toBeUndefined(); }
    expect(run.snapshot().tracks).toBeUndefined();
    await run.close();
  });

  it('a track that did not ask for a share (a plain split) has no share, and is capped by the room like a main-line subagent (m3 fix A item 2)', async () => {
    const h = m2harness('M12p');
    const body = '## split\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n' + A_PHASE + '\n\n' + B_PHASE;
    const run = mk(h, body, usdB(1));
    await drive(run);
    expect(h.subagentOpens).toHaveLength(2);
    for (const o of h.subagentOpens) { expect(o.maxUsd).toBe(1); expect(o.usdRoom!()).toBe(1); }
    await run.close();
  });
});

/** The worked numbers of the spec: $1.00; $0.10 spent before; three tracks at 0.30; a spends 0.01 then is cut off at 0.30 (0.31 in all). */
function scenario(name: string, o: { cEnds: boolean; live?: boolean }) {
  const h = m2harness(name);
  const aId = subOf(name, 'a');
  h.script(mainOf(name), reply('p', 0.1));
  h.script(subOf(name, 'c'), reply('c', 0.05));
  // the turn after the cut waits for `open()`, so a test can look at the run while it is the turn in flight
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const pass: ScriptedTurn = { text: 'a3\nREINS: pass', cost: 0, hold: () => gate };
  h.script(aId, reply('a1', 0.01), cut(0.3), ...(o.live ? [pass] : []));
  // A reopened conversation is a new fake engine session: it answers from its own list, so the list is set as it opens.
  const opener = async (x: SubagentOpen): Promise<SubagentOpened> => {
    if (x.sessionId === aId && !o.live) h.script(aId, pass);
    const r = await h.openSubagent(x);
    return o.live ? { ...r, cap: 'live' } : r;
  };
  const ha = h.hold(aId);
  const hb = h.hold(subOf(name, 'b'));
  const hc = o.cEnds ? undefined : h.hold(subOf(name, 'c'));
  const run = mk(h, THREE(A_VERIFY), usdB(1), { openSubagent: opener });
  const driven = drive(run);
  return { h, run, driven, ha, hb, hc, open };
}

describe('a capped reply is not a reply', () => {
  it('4 and 5: cut off at the share with free room: the track takes spent plus free, reopens with the room and CARRY_ON, no card, no verify result for the cut reply', async () => {
    const { h, run, driven, ha, hb, open } = scenario('M5', { cEnds: true });
    await ha.started;
    await until(() => ended(run, 'c'));
    ha.release();
    await until(() => run.tracks.get('a')?.share !== undefined && Math.abs(run.tracks.get('a')!.share! - 0.55) < 1e-9);
    expect(run.status).toBe('running');
    expect(named(run, 'budget_reached')).toEqual([]);
    expect(run.pauses()).toEqual([]);
    // the reply that was cut is not a reply: the verify logs nothing for it, runs again, and its turn is CARRY_ON on the resumed session
    expect(named(run, 'verify_result').filter((e) => e.data.track === 'a')).toEqual([]);
    await until(() => h.stats(subOf('M5', 'a')).texts.length === 3);
    const aId = subOf('M5', 'a');
    expect(h.stats(aId).texts[2]).toContain('[Reins · the run was resumed] Carry on with your task from where you stopped.');
    expect(h.stats(aId).texts[1]).not.toContain('[Reins · the run was resumed]');
    expect(h.stats(aId)).toMatchObject({ opened: 2, closed: 1 });   // dropped and reopened with the id it had
    expect(opensOf(h, 'a')[1]).toMatchObject({ sessionId: aId, maxUsd: 0.24 });
    const warn = named(run, 'budget_warning').filter((e) => e.data.track === 'a');
    expect(warn.map((e) => e.data.text)).toEqual(['Branch ssplit-1 used its share of the USD budget; it goes on with $0.24 the others left unused.']);
    open();
    hb.release();
    expect(await within(driven, 3000)).toBeUndefined();
    expect(run.status).toBe('done');
    expect(named(run, 'verify_result').filter((e) => e.data.track === 'a').map((e) => e.data.pass)).toEqual([true]);
    expect(named(run, 'budget_reached')).toEqual([]);
    await run.close();
  });

  it('6: b and c both hold 0.30, free room is below a cent: ONE run-wide card with no step, and the share is not changed', async () => {
    const { run, driven, ha, hb, hc } = scenario('M6', { cEnds: false });
    await ha.started;
    ha.release();
    await until(() => run.status === 'paused');
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', onTrack: 'a' });
    expect(run.pauseReason!.stepId).toBeUndefined();
    expect(run.pauses()).toHaveLength(1);
    expect(named(run, 'budget_reached')).toHaveLength(1);
    expect(named(run, 'budget_warning')).toEqual([]);
    expect(run.tracks.get('a')!.share).toBe(0.3);
    hb.release(); hc!.release();
    await run.stop();
    await within(driven, 3000);
    await run.close();
  });

  it('6b: free room of half a cent is less than a cent: the card, not a reopen', async () => {
    const h = m2harness('M6b');
    h.script(mainOf('M6b'), reply('p', 0.1));
    h.script(subOf('M6b', 'c'), reply('c', 0.29));
    h.script(subOf('M6b', 'a'), reply('a1', 0.005), cut(0.3));   // 0.305 in all; room 1.00 - 0.10 - 0.29 - 0.305 = 0.305; b holds 0.30
    const ha = h.hold(subOf('M6b', 'a')), hb = h.hold(subOf('M6b', 'b'));
    const run = mk(h, THREE(A_VERIFY), usdB(1));
    const driven = drive(run);
    await ha.started;
    await until(() => ended(run, 'c'));
    ha.release();
    await until(() => run.status === 'paused');
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', onTrack: 'a' });
    expect(named(run, 'budget_warning')).toEqual([]);
    expect(opensOf(h, 'a')).toHaveLength(1);
    hb.release();
    await run.stop();
    await within(driven, 3000);
    await run.close();
  });

  it('7: Allow $0.50 raises the workflow allowance once and gives every live track spent plus the new room divided by the live tracks', async () => {
    const { h, run, driven, ha, hb, hc, open } = scenario('M7', { cEnds: false });
    await ha.started;
    ha.release();
    await until(() => run.status === 'paused');
    expect(run.allowUsd(0.5)).toBeUndefined();
    const again = drive(run);
    expect(run.snapshot().usdExtra).toEqual({ '': 0.5 });
    const each = (1.5 - 0.41) / 3;
    expect(run.tracks.get('a')!.share).toBeCloseTo(0.31 + each, 5);
    expect(run.tracks.get('b')!.share).toBeCloseTo(each, 5);
    expect(run.tracks.get('c')!.share).toBeCloseTo(each, 5);
    // a is idle: its session goes and the track reopens under the new cap; b and c have a turn in flight and keep theirs
    await until(() => opensOf(h, 'a').length === 2);
    expect(opensOf(h, 'a')[1]!.maxUsd).toBeCloseTo(each, 5);
    open();
    hb.release(); hc!.release();
    expect(await within(again, 3000)).toBeUndefined();
    await driven;
    expect(run.status).toBe('done');
    await run.close();
  });

  it('a re-share never gives room to an unknown track: with a reply of unknown cost somewhere, the cut track goes to the one card, no warning, no new share', async () => {
    const h = m2harness('M5u');
    h.script(mainOf('M5u'), reply('p', 0.1));
    h.script(subOf('M5u', 'c'), { text: 'c\nREINS: done', unknownCost: true });
    // a's cut reply is in flight (waits on `go`) when c's reply of unknown cost lands: the re-share finds the run's spend unknown
    let go!: () => void;
    const gate = new Promise<void>((r) => { go = r; });
    h.script(subOf('M5u', 'a'), reply('a1', 0.01), { ...cut(0.3), hold: () => gate });
    const ha = h.hold(subOf('M5u', 'a'));
    const hb = h.hold(subOf('M5u', 'b'));
    const hc = h.hold(subOf('M5u', 'c'));
    const run = mk(h, THREE(A_VERIFY), usdB(1));
    const driven = drive(run);
    await ha.started;
    ha.release();
    await until(() => h.stats(subOf('M5u', 'a')).texts.length === 2);
    hc.release();
    await until(() => ended(run, 'c'));
    go();
    await until(() => run.status === 'paused');
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', text: USD_UNKNOWN });
    expect(named(run, 'budget_warning')).toEqual([]);
    expect(run.tracks.get('a')!.share).toBe(0.3);
    hb.release();
    await run.stop();
    await within(driven, 3000);
    await run.close();
  });

  it('a loop branch (cap live) re-shared: its room closure sees the new share, nothing is reopened, the next turn is CARRY_ON on the same session', async () => {
    const { h, run, driven, ha, hb, open } = scenario('M5l', { cEnds: true, live: true });
    await ha.started;
    const room = opensOf(h, 'a')[0]!.usdRoom!;
    expect(room()).toBeCloseTo(0.3, 9);   // the share left, now
    await until(() => ended(run, 'c'));
    ha.release();
    await until(() => run.tracks.get('a')?.share !== undefined && Math.abs(run.tracks.get('a')!.share! - 0.55) < 1e-9);
    await until(() => h.stats(subOf('M5l', 'a')).texts.length === 3);
    expect(room()).toBeCloseTo(0.24, 9);   // 0.55 - 0.31
    expect(h.stats(subOf('M5l', 'a'))).toMatchObject({ opened: 1, closed: 0 });
    expect(opensOf(h, 'a')).toHaveLength(1);
    expect(h.stats(subOf('M5l', 'a')).texts[2]).toContain('[Reins · the run was resumed]');
    open();
    hb.release();
    expect(await within(driven, 3000)).toBeUndefined();
    await run.close();
  });
});

describe('a subagent inside a track, the turn budget', () => {
  const SUBA = (before: string) => `## split\nnext: ${before ? 'a' : 'subagent-1'}\nnext: b\n\n## phase main\n> m\n\n## end\n\n` +
    (before ? '## phase a\n> a\n\n' : '') + '## subagent research\nmodel: m1\nusd: 0.2\n> Look.\n\n## end\n\n' + B_PHASE;

  it('8: a subagent with usd 0.20 inside a track with a share of 0.50 is capped at 0.20; with 0.10 of the share left, at 0.10; its spend is the track\'s', async () => {
    const h = m2harness('M8');
    h.script(subOf('M8', 'subagent-1'), reply('found', 0.05));
    const run = mk(h, SUBA('').replace('split', 'ssplit'), usdB(1));
    await drive(run);
    expect(run.status).toBe('done');
    expect(opensOf(h, 'subagent-1').map((o) => o.maxUsd)).toEqual([0.2]);   // the subagent's session: the smaller of its own 0.20 and the 0.50 share
    expect(named(run, 'track_ended').find((e) => e.data.track === 'subagent-1')!.data.cost).toBeCloseTo(0.05, 9);
    await run.close();

    const g = m2harness('M8b');
    g.script(mainOf('M8b'), reply('m', 0));
    g.script(subOf('M8b', 'a'), reply('a', 0.4));
    g.script(subOf('M8b', 'subagent-1'), reply('found', 0.05));
    const left = mk(g, SUBA('a').replace('split', 'ssplit'), usdB(1));
    await drive(left);
    expect(left.status).toBe('done');
    const sub = g.subagentOpens.filter((o) => o.step === 'subagent-1');
    expect(sub.map((o) => o.maxUsd)).toEqual([0.1]);   // 0.50 share - 0.40 spent
    expect(named(left, 'track_ended').find((e) => e.data.track === 'a')!.data.cost).toBeCloseTo(0.45, 9);
    await left.close();
  });

  it('9: a subagent slice used up inside a track: one run-wide card, and no other track starts an instruction', async () => {
    const h = m2harness('M9');
    h.script(subOf('M9', 'subagent-1'), { text: 'cap', cost: 0.25, isError: true });
    const hb = h.hold(subOf('M9', 'b'));
    const body = '## ssplit\nnext: subagent-1\nnext: b\n\n## phase main\n> m\n\n## end\n\n## subagent research\nmodel: m1\nusd: 0.2\n> Look.\n\n## end\n\n## phase b\n> b\n\n## phase b2\n> b2\n\n## end';
    const run = mk(h, body, usdB(2));
    const driven = drive(run);
    await hb.started;
    await until(() => run.status === 'paused');
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', stepId: 'subagent-1', onTrack: 'subagent-1' });
    expect(run.pauses()).toHaveLength(1);
    hb.release();
    await sleep(60);
    expect(h.stats(subOf('M9', 'b')).texts).toHaveLength(1);   // b's second instruction never started
    expect(named(run, 'budget_reached')).toHaveLength(1);
    await run.stop();
    await within(driven, 3000);
    await run.close();
  });

  it('10: the turn budget hit on a track is one run-wide pause, and the other track starts nothing more', async () => {
    const h = m2harness('M10');
    const hb = h.hold(subOf('M10', 'b'));
    const body = '## ssplit\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## phase a2\n> a2\n\n## end\n\n## phase b\n> b\n\n## phase b2\n> b2\n\n## end';
    const run = mk(h, body, usdB(5, 1));
    const driven = drive(run);
    await hb.started;
    await until(() => run.status === 'paused');
    expect(run.pauseReason).toEqual({ type: 'run-turn-budget-used' });
    expect(run.pauses()).toHaveLength(1);
    hb.release();
    await sleep(60);
    expect(h.stats(subOf('M10', 'b')).texts).toHaveLength(1);
    expect(h.stats(subOf('M10', 'a')).texts).toHaveLength(1);
    await run.stop();
    await within(driven, 3000);
    await run.close();
  });
});

describe('the bound', () => {
  it('11: every process may overshoot its cap by one call of 0.05; with a re-share the spend stays within the limit plus one call per track and one for the re-share', async () => {
    const L = 0.9;
    const h = m2harness('M11');
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const aId = subOf('M11', 'a');
    // c ends at 0.05 (0.25 of its share unused); a is cut at 0.35 (0.05 over its 0.30), takes the 0.20 that b does not hold, and is cut again after 0.25
    // (0.05 over its new cap); b, still holding 0.30, answers with 0.35 (0.05 over its cap) and ends
    h.script(aId, reply('a1', 0.01), cut(0.34));
    h.script(subOf('M11', 'b'), reply('b', 0.35));
    h.script(subOf('M11', 'c'), reply('c', 0.05));
    const ha = h.hold(aId), hb = h.hold(subOf('M11', 'b'));
    const opener = async (x: SubagentOpen) => { if (x.sessionId === aId) h.script(aId, { ...cut(0.25), hold: () => gate }); return h.openSubagent(x); };
    const run = mk(h, THREE(A_VERIFY, ''), usdB(L), { openSubagent: opener });
    const driven = drive(run);
    await ha.started;
    await until(() => ended(run, 'c'));
    ha.release();
    await until(() => h.stats(aId).texts.length === 3);   // a reopened with the 0.20 and its turn waits
    expect(opensOf(h, 'a')[1]!.maxUsd).toBe(0.2);
    hb.release();
    await until(() => ended(run, 'b'));
    open();
    await until(() => run.status === 'paused');   // a's second cut: the limit is reached, one card
    const total = run.snapshot().runCost!;
    expect(total).toBeCloseTo(1.0, 9);
    expect(total).toBeLessThanOrEqual(L + 4 * 0.05 + 1e-9);
    expect(run.pauses()).toHaveLength(1);
    expect(named(run, 'budget_reached')).toHaveLength(1);
    await run.stop();
    await within(driven, 3000);
    await run.close();
  });
});

describe('the USD card names the track, and an Allow on a track\'s inherited slice raises that track only', () => {
  const SLICE = (extra = '') => '## model claude-x\nusd: 1\n\n## phase pre\n> p\n\n## split\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n' +
    '## phase a\n> a\n\n## phase a2\n> a2\n\n## end\n\n## phase b\n> b\n\n## phase b2\n> b2\n\n## end' + extra;

  it('A and B inherit a $1 slice the starter spent 0.30 of; A spends to 1.10 and is given 0.50 more: A goes on with 0.50, B and the main line keep 1.00', async () => {
    const h = m2harness('K6');
    h.script(mainOf('K6'), reply('p', 0.3));
    h.script(subOf('K6', 'a'), reply('a', 0.8));
    const hb = h.hold(subOf('K6', 'b'));
    const run = mk(h, SLICE());
    const driven = drive(run);
    await hb.started;
    await until(() => run.status === 'paused');
    const key = trackSpendKey('a', 'model-1');
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', stepId: 'model-1', onTrack: 'a', spendKey: key });
    expect(run.pauseReason!.spent).toBeCloseTo(1.1, 9);
    expect(named(run, 'budget_reached')[0]!.data).toMatchObject({ track: 'a', step: 'model-1' });
    expect(run.allowUsd(0.5)).toBeUndefined();
    // keyed like the spend: only A's allowance moved, and it is 0.10 over plus 0.50 (the starter's 0.30 is not what A's allowance counted)
    expect(Object.keys(run.snapshot().usdExtra!)).toEqual([key]);
    expect(run.snapshot().usdExtra![key]).toBeCloseTo(0.6, 9);
    const a = run.tracks.get('a')!, b = run.tracks.get('b')!;
    expect(inner(run).usdRoom(a)).toBeCloseTo(0.5, 9);
    expect(inner(run).usdRoom(b)).toBeCloseTo(0.7, 9);
    expect(inner(run).usdRoom(run.main)).toBeCloseTo(0.7, 9);
    hb.release();
    expect(await within(drive(run), 3000)).toBeUndefined();
    await driven;
    expect(run.status).toBe('done');
    await run.close();
  });

  it('a reused track key gets no allowance from the track that used it before', async () => {
    const h = m2harness('K6r');
    h.script(mainOf('K6r'), reply('p', 0.3));
    h.script(subOf('K6r', 'a'), reply('a', 0.8));
    const hb = h.hold(subOf('K6r', 'b'));
    const run = mk(h, SLICE());
    const driven = drive(run);
    await hb.started;
    await until(() => run.status === 'paused');
    run.allowUsd(0.5);
    hb.release();
    await within(drive(run), 3000);
    await driven;
    expect(run.status).toBe('done');
    expect(Object.keys(run.snapshot().usdExtra ?? {}).filter((k) => k !== '')).toEqual([]);   // a ended: its allowance went with its counter
    await run.close();
  });

  it('the starter\'s own slice pause on the main line is unchanged: keyed by the step, no track in the pause', async () => {
    const h = m2harness('K6m');
    h.script(mainOf('K6m'), reply('p', 1.2));
    const run = mk(h, '## model claude-x\nusd: 1\n\n## phase pre\n> p\n\n## phase after\n> after');
    await drive(run);
    expect(run.pauseReason).toEqual({ type: 'usd-budget-used', stepId: 'model-1', limit: 1, spent: 1.2 });
    run.allowUsd(0.5);
    expect(run.snapshot().usdExtra).toEqual({ 'model-1': 0.7 });
    expect(named(run, 'budget_reached')[0]!.data.track).toBeUndefined();
    await run.close();
  });

  it('3: the budget pause event names the track that hit the limit; the other track starts nothing more; there is one card', async () => {
    const h = m2harness('K3');
    h.script(subOf('K3', 'a'), reply('a', 0.6));
    const hb = h.hold(subOf('K3', 'b'));
    const body = '## split\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## phase a2\n> a2\n\n## end\n\n## phase b\n> b\n\n## phase b2\n> b2\n\n## end';
    const run = mk(h, body, usdB(0.5));
    const driven = drive(run);
    await hb.started;
    await until(() => run.status === 'paused');
    expect(named(run, 'budget_reached').map((e) => e.data.track)).toEqual(['a']);
    hb.release();
    await sleep(60);
    expect(h.stats(subOf('K3', 'b')).texts).toHaveLength(1);
    expect(h.stats(subOf('K3', 'a')).texts).toHaveLength(1);
    expect(named(run, 'budget_reached')).toHaveLength(1);
    expect(run.pauses()).toHaveLength(1);
    await run.stop();
    await within(driven, 3000);
    await run.close();
  });
});

describe('one card for the run', () => {
  it('a second track whose own reply is cut off while the card is open writes no second card and does not take it over', async () => {
    const h = m2harness('K4');
    h.script(subOf('K4', 'a'), reply('a', 0.6));
    h.script(subOf('K4', 'b'), { text: 'cut\nREINS: fail', cost: 0.1, isError: true });
    const hb = h.hold(subOf('K4', 'b'));
    const body = '## split\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## phase a2\n> a2\n\n## end\n\n## phase b\n> b\n\n## end';
    const run = mk(h, body, usdB(0.5));
    const driven = drive(run);
    await hb.started;
    await until(() => run.status === 'paused');
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', onTrack: 'a' });
    hb.release();
    await sleep(60);
    expect(named(run, 'budget_reached')).toHaveLength(1);
    expect(run.pauseReason).toMatchObject({ onTrack: 'a' });
    await run.stop();
    await within(driven, 3000);
    await run.close();
  });
});

describe('a USD pause and an Allow wake a step() that sleeps', () => {
  it('8: after pauseUsd and after allowUsd the waiters are woken', async () => {
    const h = m2harness('N8');
    const run = mk(h, '## phase a\n> a\n\n## phase b\n> b', usdB(1));
    let w = run.changed();
    inner(run).pauseUsd(run.main, undefined, 1, 1);
    expect(await within(w, 200)).toBeUndefined();
    expect(run.status).toBe('paused');
    w = run.changed();
    run.allowUsd(0.5);
    expect(await within(w, 200)).toBeUndefined();
    expect(run.status).toBe('running');
    await run.close();
  });
});

describe('unknown spend: the one card (needs no new code; pinned)', () => {
  const body = (kind: string) => `## ${kind}\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## end\n\n## phase b\n> b\n\n## verify\nagainst: b\n\n## end`;

  it('an unknown reply on a under a workflow budget: b\'s next VERIFY turn goes to the one USD card, and is not sent', async () => {
    const h = m2harness('U1');
    h.script(subOf('U1', 'a'), { text: 'a\nREINS: done', unknownCost: true });
    const hb = h.hold(subOf('U1', 'b'));
    const run = mk(h, body('split'), usdB(5));
    const driven = drive(run);
    await hb.started;
    await until(() => ended(run, 'a'));
    hb.release();
    await until(() => run.status === 'paused');
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', text: USD_UNKNOWN });
    expect(run.pauses()).toHaveLength(1);
    expect(h.stats(subOf('U1', 'b')).texts).toHaveLength(1);   // the verify turn was not sent
    expect(named(run, 'budget_reached')).toHaveLength(1);
    await run.stop();
    await within(driven, 3000);
    await run.close();
  });

  it('a share track\'s room closure is NaN while the run\'s spend under a workflow limit is unknown, and a number before', async () => {
    const h = m2harness('U2');
    h.script(subOf('U2', 'a'), { text: 'a\nREINS: done', unknownCost: true });
    const hb = h.hold(subOf('U2', 'b'));
    const run = mk(h, body('ssplit'), usdB(5));
    const driven = drive(run);
    await hb.started;
    const room = opensOf(h, 'b')[0]!.usdRoom!;
    await until(() => ended(run, 'a'));
    expect(Number.isNaN(room())).toBe(true);
    hb.release();
    await run.stop();
    await within(driven, 3000);
    await run.close();
  });

  it('the room closure is a number while nothing is unknown', async () => {
    const h = m2harness('U3');
    const hb = h.hold(subOf('U3', 'b'));
    const run = mk(h, body('ssplit'), usdB(5));
    const driven = drive(run);
    await hb.started;
    expect(opensOf(h, 'b')[0]!.usdRoom!()).toBe(2.5);   // its share
    hb.release();
    await within(driven, 3000);
    await run.close();
  });
});

describe('a share is saved and checked on restore', () => {
  it('a snapshot with a share and carryOn restores them; a bad share or carryOn is refused', async () => {
    const { h, run, driven, ha, hb, hc, open } = scenario('S1', { cEnds: false });
    await ha.started;
    ha.release();
    await until(() => run.status === 'paused');
    const snap = JSON.parse(JSON.stringify(run.snapshot())) as RunSnapshot;
    open();
    hb.release(); hc!.release();
    await run.stop();
    await within(driven, 3000);
    await run.close();
    const a = snap.tracks!.find((t) => t.key === 'a')!;
    expect(a.share).toBe(0.3);
    expect(a.carryOn).toBe(true);
    const back = Run.restore(snap, { engine: h.engine, openSubagent: h.openSubagent, now: h.now });
    expect(back.tracks.get('a')).toMatchObject({ share: 0.3, carryOn: true });
    await back.close();
    for (const bad of [{ share: -1 }, { share: Number.NaN }, { share: 1e13 }, { share: '1' }, { carryOn: false }, { carryOn: 'yes' }]) {
      const s = JSON.parse(JSON.stringify(snap)) as RunSnapshot;
      Object.assign(s.tracks!.find((t) => t.key === 'a')!, bad);
      expect(() => Run.restore(s, { engine: h.engine, now: h.now })).toThrow(/saved run is inconsistent/);
    }
  });
});

describe('fix round 1: what the first round left unguarded', () => {
  it('S1-S3: a track\'s own slice Allow gives it spent plus the room the OTHER tracks do not hold (an overspent sibling holds nothing, not less than nothing)', async () => {
    const h = m2harness('R1');
    h.script(subOf('R1', 'model-1'), reply('a', 0.1), reply('a2', 0));
    h.script(subOf('R1', 'b'), reply('b', 2), reply('b2', 0));
    const hb = h.hold(subOf('R1', 'b'));
    const body = '## ssplit\nnext: model-1\nnext: b\n\n## phase main\n> m\n\n## end\n\n## model claude-x\nusd: 0.1\n\n## phase a\n> a\n\n## phase a2\n> a2\n\n## end\n\n' +
      '## phase b\n> b\n\n## phase b2\n> b2\n\n## end';
    const run = mk(h, body, usdB(3));
    const driven = drive(run);
    await hb.started;
    await until(() => run.status === 'paused');   // a used its own 0.10 slice
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', stepId: 'model-1', onTrack: 'model-1' });
    hb.release();   // b answers with 2.00 against its share of 1.50: it holds 0 (not -0.50)
    await until(() => (run.tracks.get('b')?.money?.cost ?? 0) === 2);
    await driven;
    expect(run.tracks.get('b')!.share).toBe(1.5);
    expect(run.allowUsd(0.5)).toBeUndefined();
    // room = min(workflow 3.00 - 2.10, slice 0.10 + 0.50 - 0.10) = 0.50; nobody else holds anything: 0.10 spent + 0.50
    expect(run.tracks.get('model-1')!.share).toBeCloseTo(0.6, 9);
    await run.stop();
    await run.close();
  });

  it('S4: the next process is capped at the room when that is less than the share left', async () => {
    const h = m2harness('R4');
    h.script(subOf('R4', 'a'), { text: '', reject: 'boom', paid: { cost: 0.12, total: 0.12 } });
    h.script(subOf('R4', 'b'), reply('b', 0.7));   // b spends far over its 0.30
    const reopen = async (x: SubagentOpen) => { if (x.sessionId) h.script(x.sessionId, reply('a', 0)); return h.openSubagent(x); };
    const run = mk(h, THREE(), usdB(0.9), { openSubagent: reopen });
    const driven = drive(run);
    await until(() => run.tracks.get('a')?.state === 'paused' && ended(run, 'b') && ended(run, 'c'));
    run.resume('a');
    await until(() => opensOf(h, 'a').length === 2);
    expect(opensOf(h, 'a')[1]!.maxUsd).toBe(0.08);   // 0.90 - 0.12 - 0.70 = 0.08, less than the 0.18 of the share
    expect(await within(driven, 3000)).toBeUndefined();
    await run.close();
  });

  it('S5: a saved usdExtra that is not a map of finite amounts is refused', async () => {
    const h = m2harness('R5');
    const run = mk(h, '## phase a\n> a', usdB(1));
    const snap = JSON.parse(JSON.stringify(run.snapshot())) as RunSnapshot;
    await run.close();
    for (const bad of [{ x: 'a' }, [], 'x', { x: Number.NaN }, { x: Number.POSITIVE_INFINITY }]) {
      expect(() => Run.restore({ ...snap, usdExtra: bad as never }, { engine: h.engine, now: h.now })).toThrow('saved run is inconsistent: usdExtra is not a map of amounts');
    }
    expect(() => Run.restore({ ...snap, usdExtra: { '': 0.5 } }, { engine: h.engine, now: h.now })).not.toThrow();
  });

  it('S6: CARRY_ON is sent once: the next instruction of the track sends its own step text', async () => {
    const h = m2harness('R6');
    const aId = subOf('R6', 'a');
    h.script(mainOf('R6'), reply('p', 0.1));
    h.script(subOf('R6', 'c'), reply('c', 0.05));
    h.script(aId, reply('a1', 0.01), cut(0.3), { text: 'ok\nREINS: pass', cost: 0 }, reply('a4', 0));
    const live = async (x: SubagentOpen): Promise<SubagentOpened> => ({ ...(await h.openSubagent(x)), cap: 'live' });
    const ha = h.hold(aId), hb = h.hold(subOf('R6', 'b'));
    const a = '## phase a\n> a\n\n## verify\nagainst: a\n\n## phase a4\n> the fourth instruction text\n\n## end';
    const run = mk(h, THREE(a), usdB(1), { openSubagent: live });
    const driven = drive(run);
    await ha.started;
    await until(() => ended(run, 'c'));
    ha.release();
    await until(() => h.stats(aId).texts.length === 4);
    const texts = h.stats(aId).texts;
    expect(texts[2]).toContain('[Reins · the run was resumed]');
    expect(texts[3]).toContain('the fourth instruction text');
    expect(texts[3]).not.toContain('[Reins · the run was resumed]');
    hb.release();
    expect(await within(driven, 3000)).toBeUndefined();
    await run.close();
  });

  it('S7: an engine stop for the budget on a track with a share, while some spend is unknown, gets the card that says so', async () => {
    const h = m2harness('R7');
    let go!: () => void;
    const gate = new Promise<void>((r) => { go = r; });
    h.script(subOf('R7', 'a'), { text: 'used up', cost: 0.01, isError: true, budgetStop: true, hold: () => gate });
    h.script(subOf('R7', 'c'), { text: 'c\nREINS: done', unknownCost: true });
    const hc = h.hold(subOf('R7', 'c')), hb = h.hold(subOf('R7', 'b'));
    const run = mk(h, THREE(), usdB(1));
    const driven = drive(run);
    await until(() => h.stats(subOf('R7', 'a')).texts.length === 1);   // a's turn is in flight
    hc.release();
    await until(() => ended(run, 'c'));
    go();
    await until(() => run.status === 'paused');
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', onTrack: 'a', text: USD_UNKNOWN });
    hb.release();
    await run.stop();
    await within(driven, 3000);
    await run.close();
  });

  it('S8: the card names the limit that holds the track now: the slice when it is tighter, the workflow when it is', async () => {
    const stop = { text: 'stop', cost: 0.01, isError: true, budgetStop: true };
    const h = m2harness('R8a');
    h.script(mainOf('R8a'), stop);
    const slice = mk(h, '## model claude-x\nusd: 0.5\n\n## phase a\n> a', usdB(5));
    await drive(slice);
    expect(slice.pauseReason).toMatchObject({ type: 'usd-budget-used', stepId: 'model-1', limit: 0.5 });
    await slice.close();

    const g = m2harness('R8b');
    g.script(mainOf('R8b'), reply('p', 0.8), stop);
    const wide = mk(g, '## phase pre\n> p\n\n## model claude-x\nusd: 0.5\n\n## phase a\n> a', usdB(1));
    await drive(wide);
    expect(wide.pauseReason).toMatchObject({ type: 'usd-budget-used', limit: 1 });
    expect(wide.pauseReason!.stepId).toBeUndefined();
    await wide.close();
  });
});