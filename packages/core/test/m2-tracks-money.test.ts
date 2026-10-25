// M2 task 10b: a track keeps its own money record (cost and totals), its own USD counter for an inherited slice, and its own command results and events.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { validate } from '../src/validate.js';
import { Run, trackSpendKey, type RunOptions, type RunSnapshot } from '../src/run.js';
import { register } from '../src/nodes/index.js';
import type { OpenOptions, ScriptedTurn } from '../src/fake-engine.js';
import type { Workflow } from '../src/model.js';
import { m2harness } from './m2-harness.js';
import { split } from './fixtures/split.js';

const disposers: Array<() => void> = [];
beforeAll(() => { disposers.push(register(split)); });
afterAll(() => { for (const d of disposers.splice(0).reverse()) d(); });

const wf = (body: string): Workflow => {
  const r = parseWorkflow(`---\nreins: 1\nname: t\nbudget: { turns: 40, minutes: 60 }\nalways: []\n---\n\n${body}\n`);
  expect(r.diagnostics).toEqual([]);
  expect(validate(r.workflow!).filter((d) => d.severity === 'error')).toEqual([]);
  return r.workflow!;
};
type Harness = ReturnType<typeof m2harness>;
const mk = (h: Harness, body: string, opts: Partial<RunOptions> = {}) =>
  new Run({ workflow: wf(body), engine: h.engine, openSubagent: h.openSubagent, now: h.now, ...opts });
const reply = (text: string, cost: number, total?: number, totals?: Record<string, number>): ScriptedTurn =>
  ({ text: `${text}\nREINS: done`, cost, ...(total !== undefined ? { total } : {}), ...(totals ? { totals } : {}) });
const mainOf = (s: string) => `${s}-main-1`;
const subOf = (s: string, key: string) => `${s}-sub-${key}`;
const drive = (run: Run) => (async () => { for (let k = 0; k < 50 && run.status === 'running'; k++) await run.step(); })();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean) => { for (let k = 0; k < 400 && !f(); k++) await sleep(5); expect(f()).toBe(true); };
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => 'timeout' as const)]);
const named = (run: Run, type: string) => run.getEvents().filter((e) => e.type === type);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const TRACK_A = '## split\nnext: a\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a1\n\n## phase a2\n> a2\n\n## end';
const STACK2 = '## split\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## end\n\n## phase b\n> b\n\n## end';
// A $1 slice opened before the split: both tracks inherit it. Two turns each, so the check between instructions runs after the first.
const SUB_SLICE = '## model claude-x\nusd: 1\n\n## split\nnext: subagent-1\n\n## phase main\n> m\n\n## end\n\n## subagent research\nmodel: m1\nusd: 0.5\n> Look.\n\n## end';
const SLICE2 = '## model claude-x\nusd: 1\n\n## split\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## phase a2\n> a2\n\n## end\n\n## phase b\n> b\n\n## phase b2\n> b2\n\n## end';

describe('a track\'s turns write its own money record', () => {
  it('a track total of 0.5 leaves lastTotal and lastTotals alone; the record holds cost and totals; the run cost includes it', async () => {
    const h = m2harness('A1');
    h.script(subOf('A1', 'a'), reply('a1', 0.5, 0.5, { m: 0.5 }), reply('a2', 0.25, 0.75, { m: 0.75 }));
    const snaps: RunSnapshot[] = [];
    const ref: { run?: Run } = {};
    const run = (ref.run = mk(h, TRACK_A, { onEvent: (ev) => { if (ev.type === 'turn_ended' && ev.data.track === 'a') snaps.push(clone(ref.run!.snapshot())); } }));
    await drive(run);
    expect(run.status).toBe('done');
    expect(snaps).toHaveLength(2);
    expect(snaps[0]!.lastTotal).toBeUndefined();
    expect(snaps[0]!.lastTotals).toBeUndefined();
    expect(snaps[0]!.runCost).toBeCloseTo(0.5, 9);
    expect(snaps[0]!.tracks![0]!.money).toEqual({ cost: 0.5, total: 0.5, totals: { m: 0.5 } });
    expect(snaps[1]!.runCost).toBeCloseTo(0.75, 9);
    expect(snaps[1]!.tracks![0]!.money).toEqual({ cost: 0.75, total: 0.75, totals: { m: 0.75 } });
    expect(run.snapshot().lastTotal).toBeUndefined();
    await run.close();
  });

  it('the main line\'s totals stay the main line\'s: a track turn between two main turns changes neither', async () => {
    const h = m2harness('A2');
    h.script(mainOf('A2'), reply('p', 0.3, 0.3, { m: 0.3 }));
    h.script(subOf('A2', 'a'), reply('a1', 0.5, 0.5, { z: 0.5 }), reply('a2', 0.1, 0.6, { z: 0.6 }));
    const run = mk(h, '## phase pre\n> p\n\n' + TRACK_A);
    await drive(run);
    expect(run.status).toBe('done');
    expect(run.snapshot().lastTotal).toBe(0.3);
    expect(run.snapshot().lastTotals).toEqual({ m: 0.3 });
    expect(run.snapshot().runCost).toBeCloseTo(0.9, 9);
    await run.close();
  });

  it('a terminal-style restore (no openSubagent) opens the main session with the main costBase and the track session with its own', async () => {
    const h = m2harness('B1');
    h.script(mainOf('B1'), reply('p', 0.3, 0.3, { m: 0.3 }));
    h.script(subOf('B1', 'a'), reply('a1', 0.5, 0.5, { z: 0.5 }), reply('a2', 0.1, 0.6, { z: 0.6 }));
    const hold = h.hold(subOf('B1', 'a'));   // the first turn of the track; its second turn is the one the restore runs
    const body = '## phase pre\n> p\n\n' + TRACK_A;
    const ref: { run?: Run } = {};
    let snap: RunSnapshot | undefined;
    const run = (ref.run = mk(h, body, { onEvent: (ev) => { if (ev.type === 'turn_ended' && ev.data.track === 'a' && !snap) snap = clone(ref.run!.snapshot()); } }));
    const driven = drive(run);
    await hold.started;
    hold.release();
    await until(() => snap !== undefined);
    await run.stop();
    await driven;
    await run.close();
    expect(snap!.sessionId).toBe(mainOf('B1'));
    expect(snap!.tracks![0]!.sessionId).toBe(subOf('B1', 'a'));

    const g = m2harness('B1r');
    const opens: OpenOptions[] = [];
    const engine = { ...g.engine, open: async (o: OpenOptions) => { opens.push(o); return g.engine.open(o); } };
    const back = Run.restore(snap!, { engine, now: g.now });
    await drive(back);
    expect(back.status).toBe('done');
    const track = opens.find((o) => o.sessionId === subOf('B1', 'a'));
    const main = opens.find((o) => o.sessionId === mainOf('B1'));
    expect(track).toMatchObject({ costBase: 0.5, costBaseByModel: { z: 0.5 } });
    expect(main).toMatchObject({ costBase: 0.3, costBaseByModel: { m: 0.3 } });
    await back.close();
  });

  it('a track session that reopens in the same run resumes with its own base too; one that never spent resumes from 0', async () => {
    const h = m2harness('B2');
    h.script(subOf('B2', 'a'), reply('a1', 0.5, 0.5, { z: 0.5 }));
    const hold = h.hold(subOf('B2', 'a'));
    const run = mk(h, TRACK_A);
    const driven = drive(run);
    await hold.started;
    hold.fail(new Error('boom'));   // the track pauses; its session is closed and its id kept
    await until(() => run.tracks.get('a')?.state === 'paused');
    const t = run.tracks.get('a')!;
    expect(t.money).toBeUndefined();
    t.state = 'running';
    t.pause = undefined;
    run.poke();
    await until(() => h.subagentOpens.length === 2);
    expect(h.subagentOpens[1]).toMatchObject({ sessionId: subOf('B2', 'a'), costBase: 0, costBaseByModel: {} });
    expect(await within(driven, 2000)).toBeUndefined();
    await run.close();
  });

  it('an ended track\'s cost is in its track_ended row and in the run total once', async () => {
    const h = m2harness('C1');
    h.script(mainOf('C1'), reply('m', 0.1));
    h.script(subOf('C1', 'a'), reply('a', 0.4, 0.4));
    h.script(subOf('C1', 'b'), reply('b', 0.3, 0.3));
    const run = mk(h, STACK2);
    await drive(run);
    expect(run.status).toBe('done');
    const rows = named(run, 'track_ended').map((e) => [e.data.track, e.data.cost]);
    expect(rows.sort()).toEqual([['a', 0.4], ['b', 0.3]]);
    expect(run.snapshot().runCost).toBeCloseTo(0.8, 9);
    const mainRows = named(run, 'turn_ended').filter((e) => e.data.track === undefined).reduce((a, e) => a + (e.data.cost ?? 0), 0);
    expect(mainRows + 0.4 + 0.3).toBeCloseTo(run.snapshot().runCost!, 9);   // main line + the ended tracks' rows = the run total, nothing twice
    await run.close();
  });

  it('a subagent step on a track counts its cost into the track\'s record, and its total stays on the subagent', async () => {
    const h = m2harness('C2');
    h.script(subOf('C2', 'subagent-1'), reply('found', 0.2, 0.2));
    const run = mk(h, '## split\nnext: subagent-1\n\n## phase main\n> m\n\n## end\n\n## subagent research\nmodel: m1\n> Look.\n\n## end');
    await drive(run);
    expect(run.status).toBe('done');
    expect(named(run, 'track_ended')[0]!.data.cost).toBeCloseTo(0.2, 9);
    expect(run.snapshot().runCost).toBeCloseTo(0.2, 9);
    expect(run.snapshot().lastTotal).toBeUndefined();
    await run.close();
  });

  it('the totals of a subagent on a track stay out of the track record, and its own slice counts under its step id', async () => {
    const h = m2harness('C3');
    h.script(subOf('C3', 'subagent-1'), reply('found', 0.3, 0.3));
    const snaps: RunSnapshot[] = [];
    const ref: { run?: Run } = {};
    const run = (ref.run = mk(h, SUB_SLICE, { onEvent: (ev) => { if (ev.type === 'turn_ended' && ev.data.track === 'subagent-1') snaps.push(clone(ref.run!.snapshot())); } }));
    await drive(run);
    expect(run.status).toBe('done');
    const t = snaps[0]!.tracks![0]!;
    expect(t.money?.cost).toBeCloseTo(0.3, 9);
    expect(t.money?.total).toBeUndefined();
    expect(snaps[0]!.usdSpent!['subagent-1']).toBeCloseTo(0.3, 9);
    await run.close();
  });
});

describe('a track counts an inherited slice by itself', () => {
  const held = (scenario: string) => {
    const h = m2harness(scenario);
    return { h, a: subOf(scenario, 'a'), b: subOf(scenario, 'b') };
  };

  it('two siblings each spending 0.60 against an inherited $1 slice are both fine', async () => {
    const { h, a, b } = held('D1');
    h.script(a, reply('a', 0.6, 0.6), reply('a2', 0));
    h.script(b, reply('b', 0.6, 0.6), reply('b2', 0));
    const hA1 = h.hold(a), hA2 = h.hold(a), hB1 = h.hold(b), hB2 = h.hold(b);
    const run = mk(h, SLICE2);
    const driven = drive(run);
    await Promise.all([hA1.started, hB1.started]);
    hA1.release();
    hB1.release();
    expect(await within(Promise.all([hA2.started, hB2.started]), 1000)).not.toBe('timeout');
    expect(run.status).toBe('running');
    hA2.release();
    hB2.release();
    await driven;
    expect(run.status).toBe('done');
    expect(named(run, 'budget_reached')).toEqual([]);
    expect(run.snapshot().runCost).toBeCloseTo(1.2, 9);   // the run still sees the sum
    await run.close();
  });

  it('a sibling spending $1.10 is stopped on its own slice while the other, at 0.60, is not; the run pauses as it does today', async () => {
    const { h, a, b } = held('E1');
    h.script(a, reply('a', 1.1, 1.1), reply('a2', 0));
    h.script(b, reply('b', 0.6, 0.6), reply('b2', 0));
    const hA1 = h.hold(a), hB1 = h.hold(b), hB2 = h.hold(b);
    const run = mk(h, SLICE2);
    const driven = drive(run);
    await Promise.all([hA1.started, hB1.started]);
    hB1.release();
    await hB2.started;   // b is fine at 0.60 and sends its second turn
    hA1.release();
    await until(() => run.status === 'paused');
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', stepId: 'model-1', limit: 1, spent: 1.1 });
    expect(h.stats(a).texts).toHaveLength(1);   // a sent no second turn
    hB2.release();
    await driven;
    // Allow raises the slice from what the track spent (1.10), not from the main line's counter: 1.10 - 1 + 0.50
    expect(run.allowUsd(0.5)).toBeUndefined();
    expect(run.snapshot().usdExtra).toEqual({ [trackSpendKey('a', 'model-1')]: 0.6 });   // the allowance is keyed like the spend (Task 12)
    await drive(run);
    expect(run.status).toBe('done');
    await run.close();
  });

  it('a model step on a track opens a slice of its own: its spend counts under the step id, not under the inherited key', async () => {
    const h = m2harness('J1');
    h.script(mainOf('J1'), reply('p', 0.3));
    h.script(subOf('J1', 'model-2'), reply('a', 0.4), reply('a2', 0));
    const run = mk(h, '## model claude-x\nusd: 1\n\n## phase pre\n> p\n\n## split\nnext: model-2\n\n## phase main\n> m\n\n## end\n\n## model claude-y\nusd: 0.5\n\n## phase a\n> a\n\n## phase a2\n> a2\n\n## end');
    await drive(run);
    expect(run.status).toBe('done');
    const spent = run.snapshot().usdSpent!;
    expect(spent['model-1']).toBe(0.3);
    expect(spent['model-2']).toBe(0.4);
    await run.close();
  });

  it('a track starts with what its starter had spent on the slice', async () => {
    const h = m2harness('I1');
    h.script(mainOf('I1'), reply('p', 0.3));
    h.script(subOf('I1', 'a'), reply('a', 0.8), reply('a2', 0));
    const run = mk(h, '## model claude-x\nusd: 1\n\n## phase pre\n> p\n\n## split\nnext: a\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## phase a2\n> a2\n\n## end');
    await drive(run);
    expect(run.status).toBe('paused');
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', stepId: 'model-1', spent: 1.1 });
    await run.close();
  });

  it('a snapshot round trip keeps each track\'s record and the spent of each slice', async () => {
    const { h, a, b } = held('F1');
    h.script(a, reply('a', 0.6, 0.6, { z: 0.6 }), reply('a2', 0));
    h.script(b, reply('b', 0.5, 0.5, { y: 0.5 }), reply('b2', 0));
    const hA1 = h.hold(a), hA2 = h.hold(a), hB1 = h.hold(b), hB2 = h.hold(b);
    const run = mk(h, SLICE2);
    const driven = drive(run);
    await Promise.all([hA1.started, hB1.started]);
    hA1.release();
    hB1.release();
    await Promise.all([hA2.started, hB2.started]);
    const snap = clone(run.snapshot());
    expect(snap.tracks!.map((t) => t.money)).toEqual([{ cost: 0.6, total: 0.6, totals: { z: 0.6 } }, { cost: 0.5, total: 0.5, totals: { y: 0.5 } }]);
    expect(Object.values(snap.usdSpent!).sort()).toEqual([0.5, 0.6]);
    const back = Run.restore(clone(snap), { engine: h.engine, openSubagent: h.openSubagent, now: h.now });
    const again = back.snapshot();
    expect(again.tracks!.map((t) => t.money)).toEqual(snap.tracks!.map((t) => t.money));
    expect(again.usdSpent).toEqual(snap.usdSpent);
    expect(again.runCost).toBe(snap.runCost);
    hA2.release();
    hB2.release();
    await driven;
    await run.close();
    await back.close();
  });

  it('a restored track keeps counting under its own key: a restore refuses a record that is not a record', async () => {
    const { h, a, b } = held('F2');
    const hA1 = h.hold(a), hB1 = h.hold(b);
    const run = mk(h, SLICE2);
    const driven = drive(run);
    await Promise.all([hA1.started, hB1.started]);
    const snap = clone(run.snapshot());
    for (const bad of [{ cost: 'x' }, { cost: -1 }, { cost: 1, total: 'x' }, { cost: 1, totals: { m: 'x' } }, 7, []]) {
      const s = clone(snap);
      s.tracks![0]!.money = bad as never;
      expect(() => Run.restore(s, { engine: h.engine, openSubagent: h.openSubagent, now: h.now }), JSON.stringify(bad)).toThrow(/saved run is inconsistent: /);
    }
    hA1.release();
    hB1.release();
    await run.stop();
    await within(driven, 1000);
    await run.close();
  });
});

describe('a run with no track writes the snapshot it always wrote', () => {
  it('no tracks, money or spend keys beyond the old ones', async () => {
    const h = m2harness('G1');
    h.script(mainOf('G1'), reply('p', 0.06, 0.06, { m: 0.06 }));
    const run = mk(h, '## model claude-x\nusd: 1\n\n## phase one\n> 1\n\n## end');
    await drive(run);
    const snap = run.snapshot();
    expect(snap.usdSpent).toEqual({ 'model-1': 0.06 });
    expect(snap.lastTotal).toBe(0.06);
    expect(snap.lastTotals).toEqual({ m: 0.06 });
    for (const k of ['tracks', 'groups', 'ended', 'programHash', 'kinds']) expect(Object.keys(snap)).not.toContain(k);
    await run.close();
  });
});

describe('a track\'s conditions read only its own results and events', () => {
  const LOOPS = '## split\nnext: repeat-1\nnext: repeat-2\n\n## phase main\n> m\n\n## end\n\n' +
    '## repeat\nuntil: tests pass\nmax: 2\n\n### run `npm test`\n\n### phase fix1\n> fix one\n\n## end\n\n' +
    '## repeat\nuntil: tests pass\nmax: 2\n\n### run `npm test`\n\n### phase fix2\n> fix two\n\n## end';

  // A loop judges `tests pass` only when its own run exits 0, so B (exit 1) never judges: what the shared list does is hide A's pass behind B's failure,
  // which lands between A's result and A's judging. A then runs the command again instead of leaving.
  it('branch A (exit 0) leaves its loop at once; branch B (exit 1) stays in its own and is not helped or hindered by the other', async () => {
    const h = m2harness('K1');
    let n = 0;
    const commandRunner = async () => ({ exitCode: ++n === 1 ? 0 : 1, stdout: '', stderr: '' });   // A (repeat-1) runs first and passes; B (repeat-2) fails
    const run = mk(h, LOOPS, { commandRunner });
    const driven = drive(run);
    await until(() => run.ended.some((e) => e.key === 'repeat-1'));
    await until(() => run.tracks.get('repeat-2')?.state === 'paused');
    expect(run.tracks.get('repeat-2')!.pause).toMatchObject({ type: 'budget-used', stepId: 'repeat-2' });
    expect(run.ended.map((e) => e.key)).toEqual(['repeat-1']);
    const results = run.snapshot().commandResults;
    expect(results.filter((c) => c.track === 'repeat-1').map((c) => c.exitCode)).toEqual([0]);   // judged from its own result: no second run
    expect(results.filter((c) => c.track === 'repeat-2').map((c) => c.exitCode)).toEqual([1, 1]);
    expect(results.filter((c) => c.track === undefined)).toEqual([]);
    expect(n).toBe(3);
    await run.stop();
    await within(driven, 1000);
    await run.close();
  });

  // The reverse harm, where a loop does judge from the list: `same error twice` with no command of its own in the loop.
  it('branch B\'s `same error twice` loop does not leave on branch A\'s two equal failures', async () => {
    const h = m2harness('K3');
    const hB = h.hold(subOf('K3', 'repeat-1'));
    const commandRunner = async () => ({ exitCode: 1, stdout: '', stderr: 'error 7' });
    const run = mk(h, '## split\nnext: repeat-1\nnext: repeat-2\n\n## phase main\n> m\n\n## end\n\n' +
      '## repeat\nuntil: same error twice\nmax: 2\n\n### phase wait\n> wait\n\n## end\n\n' +
      '## repeat\nuntil: tests pass\nmax: 3\n\n### run `npm test`\n\n### phase fix\n> fix\n\n## end', { commandRunner });
    const driven = drive(run);
    await hB.started;
    await until(() => run.snapshot().commandResults.filter((c) => c.track === 'repeat-2').length >= 2);
    hB.release();
    await until(() => run.tracks.get('repeat-1')?.state === 'paused' || run.ended.some((e) => e.key === 'repeat-1'));
    expect(run.ended.map((e) => e.key)).not.toContain('repeat-1');   // B has run no command: nothing of its own to be the same
    expect(run.tracks.get('repeat-1')!.pause).toMatchObject({ type: 'budget-used', stepId: 'repeat-1' });
    await run.stop();
    await within(driven, 1000);
    await run.close();
  });
  it('evalCtx gives a track its own events and command results, and the main line only its untagged ones', async () => {
    const run = mk(m2harness('K2'), STACK2);
    const inner = run as unknown as { evalCtx(t: unknown): { events: Array<{ data: { track?: string; n: number } }>; commandResults: Array<{ track?: string }> }; logEvent(type: string, data: unknown, t: unknown): void };
    const t = (key: string) => ({ ...run.main, key }) as never;
    inner.logEvent('note', { n: 1 }, run.main);
    inner.logEvent('note', { n: 2 }, t('a'));
    inner.logEvent('note', { n: 3 }, t('b'));
    run.recordCommandResult('x', 0, '');
    run.recordCommandResult('x', 1, '', t('a'));
    run.recordCommandResult('x', 1, '', t('b'));
    const seen = (key: string | undefined) => {
      const ctx = inner.evalCtx(key === undefined ? run.main : t(key));
      return { events: ctx.events.filter((e) => e.data.n !== undefined).map((e) => e.data.n), results: ctx.commandResults.map((c) => c.track) };
    };
    expect(seen(undefined)).toEqual({ events: [1], results: [undefined] });
    expect(seen('a')).toEqual({ events: [2], results: ['a'] });
    expect(seen('b')).toEqual({ events: [3], results: ['b'] });
    await run.close();
  });
});
