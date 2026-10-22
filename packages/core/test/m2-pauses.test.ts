// M2 task 11: each track pauses on its own and is answered by its key; a stop card pauses the whole run once; a detach leaves the tracks running; the
// change request retry is per track. The toy `split` (fixtures/split.ts) makes the tracks. The server's answers API and the USD pause per track are later tasks.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { validate } from '../src/validate.js';
import { Run, type PauseReason, type RunOptions, type RunSnapshot, type Track } from '../src/run.js';
import { register } from '../src/nodes/index.js';
import type { ScriptedTurn } from '../src/fake-engine.js';
import type { Cond, Workflow } from '../src/model.js';
import { m2harness } from './m2-harness.js';
import { split } from './fixtures/split.js';

const disposers: Array<() => void> = [];
beforeAll(() => { disposers.push(register(split)); });
afterAll(() => { for (const d of disposers.splice(0).reverse()) d(); });

const wf = (body: string, usd?: number): Workflow => {
  const r = parseWorkflow(`---\nreins: 1\nname: t\nbudget: { turns: 40, minutes: 60${usd === undefined ? '' : `, usd: ${usd}`} }\nalways: []\n---\n\n${body}\n`);
  expect(r.diagnostics).toEqual([]);
  expect(validate(r.workflow!).filter((d) => d.severity === 'error')).toEqual([]);
  return r.workflow!;
};

// [SPLIT, TURN main, END, TURN a, END, TURN b, END, END]
const STACK2 = '## split\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## end\n\n## phase b\n> b\n\n## end';
const GATES2 = '## split\nnext: g1\nnext: g2\n\n## end\n\n## gate\nid: g1\nuntil: you approve\n\n## end\n\n## gate\nid: g2\nuntil: you approve\n\n## end';
const A_AND_GATE = '## split\nnext: a\nnext: g\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## end\n\n## gate\nid: g\nuntil: you approve\n\n## end';
const LOOPS = '## split\nnext: repeat-1\nnext: repeat-2\n\n## phase main\n> m\n\n## end\n\n' +
  '## repeat\nuntil: tests pass\nmax: 1\n\n### run `npm test`\n\n### phase fix1\n> fix one\n\n## end\n\n' +
  '## repeat\nuntil: tests pass\nmax: 1\n\n### run `npm test`\n\n### phase fix2\n> fix two\n\n## end';
const GATE_PAIR = '## gate\nid: gm\nuntil: you approve\n\n## gate\nid: gb\nuntil: you approve\n\n## end';
const GATE: Cond = { t: 'approve' };

type Harness = ReturnType<typeof m2harness>;
const mk = (h: Harness, body: string, opts: Partial<RunOptions> & { usd?: number } = {}) => {
  const { usd, ...rest } = opts;
  return new Run({ workflow: wf(body, usd), engine: h.engine, openSubagent: h.openSubagent, now: h.now, ...rest });
};
const back = (snap: RunSnapshot, h: Harness, opts: Partial<RunOptions> = {}) =>
  Run.restore(JSON.parse(JSON.stringify(snap)) as RunSnapshot, { engine: h.engine, openSubagent: h.openSubagent, now: h.now, ...opts });
const done = (text: string): ScriptedTurn => ({ text: `${text}\nREINS: done` });
/** The engine ended the reply as an error: the loop's way of saying the USD limit is reached. */
const capped = (cost: number): ScriptedTurn => ({ text: 'The USD budget is used up.', cost, isError: true });
const mainOf = (s: string) => `${s}-main-1`;
const subOf = (s: string, key: string) => `${s}-sub-${key}`;

const drive = (run: Run) => (async () => { for (let k = 0; k < 50 && run.status === 'running'; k++) await run.step(); })();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean) => { for (let k = 0; k < 400 && !f(); k++) await sleep(5); expect(f()).toBe(true); };
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => 'timeout' as const)]);
const named = (run: Run, type: string) => run.getEvents().filter((e) => e.type === type);
const paused = (run: Run, ...keys: string[]) => () => keys.every((k) => run.tracks.get(k)?.state === 'paused');
const addTrack = (run: Run, key: string, at: number): Track => {
  const t: Track = { key, title: key, parent: '', group: '', pc: at, state: 'running', turnInFlight: false, capped: false, handback: [], policy: { mode: 'write', guards: [], allowShell: true }, recall: [] };
  run.tracks.set(key, t);
  return t;
};
/** Stop and close, then let the loop that was asleep in step() end. */
const finish = async (run: Run, driven?: Promise<unknown>) => { await run.stop(); if (driven) expect(await within(driven, 1000)).toBeUndefined(); await run.close(); };

describe('a track pauses on its own', () => {
  it('B at a gate while A\'s turn is held: pauses() lists it with its key and title, the run keeps running, and approve(key) wakes changed() before A ends', async () => {
    const h = m2harness('Q1');
    const hA = h.hold(subOf('Q1', 'a'));
    const run = mk(h, A_AND_GATE);
    const driven = drive(run);
    await hA.started;
    await until(paused(run, 'g'));
    expect(run.status).toBe('running');
    expect(run.pauseReason).toBeUndefined();
    expect(run.pauses()).toEqual([{ track: 'g', title: 'Split split-1', type: 'gate', stepId: 'g', cond: GATE }]);
    expect(run.tracks.get('g')!.pause).toEqual({ type: 'gate', stepId: 'g', cond: GATE });   // stored as it was paused; pauses() adds the key and title
    run.approve();   // the run's own pause: there is none
    expect(run.pauses()).toHaveLength(1);
    const woke = run.changed().then(() => 'woke' as const);
    run.approve('g');
    expect(await within(woke, 500)).toBe('woke');
    expect(named(run, 'gate_approved').map((e) => e.data)).toEqual([{ track: 'g' }]);
    expect(run.pauses()).toEqual([]);
    expect(named(run, 'turn_ended')).toEqual([]);   // A's turn is still held
    hA.release();
    await driven;
    expect(run.status).toBe('done');
    await run.close();
  });

  it('two paused tracks and the main line parked: status stays running, pauses() lists both in start order, and each key answers only its own', async () => {
    const h = m2harness('Q2');
    const run = mk(h, GATES2);
    const driven = drive(run);
    await until(paused(run, 'g1', 'g2'));
    expect(run.status).toBe('running');
    expect(run.pauseReason).toBeUndefined();
    expect(run.pauses().map((p) => [p.track, p.title, p.type, p.stepId])).toEqual([['g1', 'Split split-1', 'gate', 'g1'], ['g2', 'Split split-1', 'gate', 'g2']]);
    run.approve('nope');
    run.approve('');   // the main line's key: it has no pause
    expect(run.pauses()).toHaveLength(2);
    run.approve('g2');
    expect(run.pauses().map((p) => p.track)).toEqual(['g1']);
    expect(run.tracks.get('g1')!.pc).toBe(2);   // g1 did not move
    run.approve('g1');
    expect(await within(driven, 1000)).toBeUndefined();
    await until(() => run.status === 'done' || run.ended.length === 2);
    await finish(run);
  });

  it('pauses() lists the run\'s own pause first, with no key, then each paused track; a keyed answer of the wrong kind does nothing', async () => {
    const h = m2harness('Q2b');
    const run = mk(h, GATES2);
    const driven = drive(run);
    await until(paused(run, 'g1', 'g2'));
    run.queueCard('look at this', 'stop');   // no turn in flight: the run pauses at once, the tracks keep their own pauses
    expect(run.status).toBe('paused');
    const all = run.pauses();
    expect(all.map((p) => p.track)).toEqual([undefined, 'g1', 'g2']);
    expect('track' in all[0]!).toBe(false);
    expect('title' in all[0]!).toBe(false);
    expect(all[0]).toEqual({ type: 'stop', text: 'look at this' });
    run.resume('g1');   // g1 waits at a gate: Resume is not its answer
    run.allowMore(1, 'g1');
    expect(run.pauses()).toHaveLength(3);
    run.resume();
    expect(run.pauses().map((p) => p.track)).toEqual(['g1', 'g2']);
    await finish(run, driven);
  });

  it('REINS: blocked in A pauses A; B runs to its end; resume(key, note) runs A\'s step again and its next turn carries the note, which is no steer card', async () => {
    const h = m2harness('Q3');
    h.script(subOf('Q3', 'a'), { text: 'stuck\nREINS: blocked: no api' }, done('fixed'));
    h.script(subOf('Q3', 'b'), done('beta'));
    const run = mk(h, STACK2);
    const driven = drive(run);
    await until(paused(run, 'a'));
    await until(() => run.ended.some((e) => e.key === 'b'));
    expect(run.status).toBe('running');
    expect(run.pauses()).toEqual([{ track: 'a', title: 'Split split-1', type: 'agent-blocked', reason: 'no api' }]);
    run.resume('a', 'try the other API');
    expect(run.snapshot().pendingCards).toEqual([]);
    expect(named(run, 'card_queued')).toEqual([]);
    expect(named(run, 'run_resumed').map((e) => e.data)).toEqual([{ track: 'a' }]);
    await driven;
    expect(run.status).toBe('done');
    const a = h.stats(subOf('Q3', 'a')).texts;
    expect(a).toHaveLength(2);
    expect(a[0]).not.toContain('try the other API');
    expect(a[1]).toContain('try the other API');
    expect(named(run, 'card_delivered').map((e) => e.data)).toEqual([{ card: 'try the other API', channel: 'next-turn', track: 'a' }]);
    expect(h.stats(mainOf('Q3')).texts.join('\n')).not.toContain('try the other API');   // not the main line's
    await run.close();
  });

  it('a note typed with Resume on the main line is queued as a steer card, as the driver always did', async () => {
    const h = m2harness('Q3b');
    const run = mk(h, '## phase one\n> 1\n\n## end');
    run.queueCard('hold', 'stop');
    expect(run.status).toBe('paused');
    run.resume(undefined, 'carry on like this');
    expect(run.status).toBe('running');
    expect(run.snapshot().pendingCards).toEqual(['carry on like this']);
    await run.close();
  });

  it('requestChanges(note, key) sends its turn on that track\'s session, with the track\'s own gate; the gate asks again', async () => {
    const h = m2harness('Q5');
    const run = mk(h, GATES2);
    const driven = drive(run);
    await until(paused(run, 'g1', 'g2'));
    await run.requestChanges('tighten the plan', 'g2');
    const texts = h.stats(subOf('Q5', 'g2')).texts;
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('tighten the plan');
    expect(h.opened).toEqual([subOf('Q5', 'g2')]);   // not g1's session, not the main line's
    expect(run.tracks.get('g2')!.policy.pendingGate).toBe('g2');   // the writes of its session are locked until the gate is approved
    expect(run.tracks.get('g1')!.policy.pendingGate).toBeUndefined();
    expect(run.pauses().map((p) => [p.track, p.type, p.stepId])).toEqual([['g1', 'gate', 'g1'], ['g2', 'gate', 'g2']]);
    expect(named(run, 'card_delivered').map((e) => e.data)).toEqual([{ card: 'tighten the plan', channel: 'next-turn', source: 'gate-changes', track: 'g2' }]);
    await run.requestChanges('nothing', 'g1');
    expect(h.stats(subOf('Q5', 'g1')).texts).toHaveLength(1);
    await run.requestChanges('wrong key');   // the run itself has no gate
    expect(h.opened).toEqual([subOf('Q5', 'g2'), subOf('Q5', 'g1')]);
    await finish(run, driven);
  });

  it('allowMore(n, key) at B\'s loop budget pause lets B try again and does not touch A\'s pause', async () => {
    const h = m2harness('Q6');
    const commandRunner = async () => ({ exitCode: 1, stdout: '', stderr: '' });
    const run = mk(h, LOOPS, { commandRunner });
    const driven = drive(run);
    await until(paused(run, 'repeat-1', 'repeat-2'));
    expect(run.pauses().map((p) => [p.track, p.type, p.stepId])).toEqual([['repeat-1', 'budget-used', 'repeat-1'], ['repeat-2', 'budget-used', 'repeat-2']]);
    const ranOf = (k: string) => run.snapshot().commandResults.filter((c) => c.track === k).length;
    expect([ranOf('repeat-1'), ranOf('repeat-2')]).toEqual([1, 1]);
    run.allowMore(1);   // the run has no budget pause of its own
    expect(run.pauses()).toHaveLength(2);
    run.allowMore(1, 'repeat-2');
    expect(run.snapshot().loopLimitExtensions).toEqual({ 'repeat-2': 1 });
    expect(named(run, 'run_resumed').map((e) => e.data)).toEqual([{ allowMore: 1, track: 'repeat-2' }]);
    await until(() => ranOf('repeat-2') === 2);
    await until(paused(run, 'repeat-1', 'repeat-2'));   // one more attempt, then its budget is used again
    expect(ranOf('repeat-1')).toBe(1);
    expect(run.pauses().map((p) => p.track)).toEqual(['repeat-1', 'repeat-2']);
    await finish(run, driven);
  });

  it('M1 callers: with no key every answer acts on the run\'s own pause, as before', async () => {
    const h = m2harness('Q7');
    const run = mk(h, '## phase one\n> 1\n\n## gate\nid: g\nuntil: you approve\n\n## phase two\n> 2\n\n## end');
    for (let k = 0; k < 5 && run.status === 'running'; k++) await run.step();
    expect(run.pauses()).toEqual([{ type: 'gate', stepId: 'g', cond: GATE }]);
    expect(run.pauses()[0]).toEqual(run.pauseReason);
    run.approve();
    expect(run.status).toBe('running');
    expect(run.pauses()).toEqual([]);
    await run.close();
  });
});

describe('a stop card with tracks in flight', () => {
  it('one run_paused for the run, both turns interrupted, neither step marked done, and resume() runs both again', async () => {
    const h = m2harness('Q4');
    h.script(subOf('Q4', 'a'), done('alpha'));
    h.script(subOf('Q4', 'b'), done('beta'));
    const hA = h.hold(subOf('Q4', 'a')), hB = h.hold(subOf('Q4', 'b'));
    const run = mk(h, STACK2);
    const driven = drive(run);
    await Promise.all([hA.started, hB.started]);
    run.queueCard('hold on', 'stop');
    await until(() => run.status === 'paused');
    expect(await within(driven, 1000)).toBeUndefined();
    await until(() => !run.tracks.get('a')!.inflight && !run.tracks.get('b')!.inflight);
    expect(named(run, 'run_paused').map((e) => e.data)).toEqual([{ reason: 'stop', text: 'hold on' }]);   // one row, the run's, with no track
    expect(h.stats(subOf('Q4', 'a')).interrupts).toBe(1);
    expect(h.stats(subOf('Q4', 'b')).interrupts).toBe(1);
    expect(run.pauses()).toEqual([{ type: 'stop', text: 'hold on' }]);
    expect(run.stopHeld).toBe(false);
    for (const k of ['a', 'b']) expect(run.tracks.get(k)!.state).toBe('running');   // the stop is the run's: the tracks keep running
    expect(run.snapshot().turnOutputs).toEqual({});   // no step is done
    expect(run.tracks.get('a')!.pc).toBe(3);
    expect(run.tracks.get('b')!.pc).toBe(5);
    run.resume();
    await drive(run);
    expect(run.status).toBe('done');
    for (const k of ['a', 'b']) {
      const texts = h.stats(subOf('Q4', k)).texts;
      expect(texts).toHaveLength(2);   // the interrupted turn, then the same step again
      expect(texts[1]).toBe(texts[0]);
    }
    expect(run.ended.map((e) => e.text)).toEqual(expect.arrayContaining(['alpha', 'beta']));
    expect(named(run, 'run_resumed')).toHaveLength(1);
    await run.close();
  });

  it('a stop card typed twice while the turns are held interrupts each turn once and still pauses once', async () => {
    const h = m2harness('Q4b');
    const hA = h.hold(subOf('Q4b', 'a')), hB = h.hold(subOf('Q4b', 'b'));
    const run = mk(h, STACK2);
    const driven = drive(run);
    await Promise.all([hA.started, hB.started]);
    run.queueCard('first', 'stop');
    run.queueCard('second', 'stop');
    expect(run.stopHeld).toBe(true);   // the held turns are on tracks; the main line has none in flight
    await until(() => run.status === 'paused');
    await driven;
    expect(h.stats(subOf('Q4b', 'a')).interrupts).toBe(1);
    expect(h.stats(subOf('Q4b', 'b')).interrupts).toBe(1);
    expect(named(run, 'run_paused').map((e) => e.data)).toEqual([{ reason: 'stop', text: 'first' }]);
    await finish(run);
  });
});

describe('detach (close without a Stop)', () => {
  it('two held turns reject "closed"; both tracks stay running with no pause; restored and driven, both run their step again', async () => {
    const h1 = m2harness('D1');
    const hA = h1.hold(subOf('D1', 'a')), hB = h1.hold(subOf('D1', 'b'));
    const run = mk(h1, STACK2);
    await run.step();   // the split starts a and b
    const first = run.step();
    await Promise.all([hA.started, hB.started]);
    const closing = run.close();
    await first;
    await closing;
    for (const k of ['a', 'b']) expect(run.tracks.get(k)!.state).toBe('running');
    expect(named(run, 'run_paused')).toEqual([]);
    expect(run.pauses()).toEqual([]);
    expect(run.status).toBe('running');
    const snap = JSON.parse(JSON.stringify(run.snapshot())) as RunSnapshot;
    expect(snap.status).toBe('running');
    expect(snap.tracks!.map((t) => [t.key, t.status, t.sessionId])).toEqual([['a', 'running', subOf('D1', 'a')], ['b', 'running', subOf('D1', 'b')]]);

    const h2 = m2harness('D1');
    h2.script(subOf('D1', 'a'), done('alpha'));
    h2.script(subOf('D1', 'b'), done('beta'));
    const again = back(snap, h2);
    await drive(again);
    expect(again.status).toBe('done');
    for (const k of ['a', 'b']) expect(h2.stats(subOf('D1', k)).texts).toHaveLength(1);   // the step ran again
    expect(named(again, 'run_paused')).toEqual([]);
    await again.close();
  });
});

describe('the change request retry is per track', () => {
  const gateOf = (id: string): PauseReason => ({ type: 'gate', stepId: id, cond: GATE });

  it('a capped requestChanges on B replays through B only; the main line\'s session is never opened', async () => {
    const h = m2harness('C1');
    h.script(subOf('C1', 'g2'), capped(0.2), done('revised'));
    const run = mk(h, GATES2, { usd: 0.1 });
    const driven = drive(run);
    await until(paused(run, 'g1', 'g2'));
    await run.requestChanges('x', 'g2');
    run.poke();   // what a driver does when a question settles: the USD pause is the run's own, written without waking step()
    await driven;
    expect(run.pauseReason?.type).toBe('usd-budget-used');
    const snap = run.snapshot();
    expect(snap).not.toHaveProperty('changeRequest');   // the main line's slot stays empty
    expect(snap.tracks!.find((t) => t.key === 'g2')!.changeRequest).toEqual({ note: 'x', gate: gateOf('g2') });
    expect(run.tracks.get('g2')!.state).toBe('running');   // the USD card is the run's; B goes on after Allow
    expect(run.allowUsd(1)).toBeUndefined();
    const again = drive(run);
    await until(paused(run, 'g1', 'g2'));
    const texts = h.stats(subOf('C1', 'g2')).texts;
    expect(texts).toHaveLength(2);
    expect(texts[1]).toBe(texts[0]);   // the same request, sent again
    expect(h.opened).toEqual([subOf('C1', 'g2')]);   // the main line never opened a session
    expect(run.snapshot().tracks!.find((t) => t.key === 'g2')!.changeRequest).toBeUndefined();
    expect(run.pauses().map((p) => [p.track, p.type])).toEqual([['g1', 'gate'], ['g2', 'gate']]);
    await finish(run, again);
  });

  it('B\'s request does not erase the main line\'s retry, and the main line still sends it after Allow', async () => {
    const h = m2harness('C2');
    h.script(mainOf('C2'), capped(0.2));
    const run = mk(h, GATE_PAIR, { usd: 0.1 });
    await run.step();   // the main line pauses at its gate
    const b = addTrack(run, 'gb', 1);
    b.state = 'paused';
    b.pause = gateOf('gb');
    await run.requestChanges('main note');
    expect(run.pauseReason?.type).toBe('usd-budget-used');
    expect(run.snapshot().changeRequest?.note).toBe('main note');
    await run.requestChanges('b note', 'gb');
    expect(run.snapshot().changeRequest?.note).toBe('main note');   // still there
    expect(b.changeRequest).toBeUndefined();
    expect(b.pause).toEqual(gateOf('gb'));
    expect(b.state).toBe('paused');
    expect(h.stats(subOf('C2', 'gb')).texts).toHaveLength(1);
    expect(run.allowUsd(1)).toBeUndefined();
    await run.step();   // the main line sends its request again
    const texts = h.stats(mainOf('C2')).texts;
    expect(texts).toHaveLength(2);
    expect(texts[1]).toBe(texts[0]);
    expect(texts[1]).toContain('main note');
    expect(run.snapshot()).not.toHaveProperty('changeRequest');
    expect(run.pauseReason).toEqual(gateOf('gm'));
    await run.stop();
    await run.close();
  });

  it('a track\'s retry comes back through a snapshot and a restore, and is sent on that track\'s resumed session', async () => {
    const h = m2harness('C3');
    h.script(subOf('C3', 'g2'), capped(0.2));
    const run = mk(h, GATES2, { usd: 0.1 });
    const driven = drive(run);
    await until(paused(run, 'g1', 'g2'));
    await run.requestChanges('x', 'g2');
    const snap = JSON.parse(JSON.stringify(run.snapshot())) as RunSnapshot;
    await finish(run, driven);

    const h2 = m2harness('C3');
    h2.script(subOf('C3', 'g2'), done('revised'));
    const again = back(snap, h2);
    expect(again.tracks.get('g2')!.changeRequest).toEqual({ note: 'x', gate: gateOf('g2') });
    expect(again.tracks.get('g1')!.changeRequest).toBeUndefined();
    expect(JSON.parse(JSON.stringify(again.snapshot())).tracks).toEqual(snap.tracks);
    expect(again.allowUsd(1)).toBeUndefined();
    const d2 = drive(again);
    await until(paused(again, 'g1', 'g2'));
    expect(h2.opened).toEqual([subOf('C3', 'g2')]);   // the resumed session of g2
    expect(h2.subagentOpens[0]).toMatchObject({ step: 'g2', sessionId: subOf('C3', 'g2') });
    expect(h2.stats(subOf('C3', 'g2')).texts[0]).toContain('the user asked for changes');
    await finish(again, d2);
  });

  it('a saved change request that is not a note and a gate is refused', async () => {
    const h = m2harness('C4');
    const run = mk(h, GATES2);
    const driven = drive(run);
    await until(paused(run, 'g1', 'g2'));
    const snap = JSON.parse(JSON.stringify(run.snapshot())) as RunSnapshot;
    await finish(run, driven);
    (snap.tracks![0] as { changeRequest?: unknown }).changeRequest = { note: 5 };
    expect(() => back(snap, m2harness('C4'))).toThrow('has a change request that is not a note and a gate');
  });
});

describe('keys and saved notes', () => {
  it('an empty key is the run\'s own pause', async () => {
    const h = m2harness('K1');
    const run = mk(h, '## phase one\n> 1\n\n## gate\nid: g\nuntil: you approve\n\n## phase two\n> 2\n\n## end');
    for (let k = 0; k < 5 && run.status === 'running'; k++) await run.step();
    expect(run.status).toBe('paused');
    run.approve('');
    expect(run.status).toBe('running');
    await run.close();
  });

  it('a note typed with a track\'s Resume survives a snapshot taken before the track runs again, and a bad saved note is refused', async () => {
    const h = m2harness('K2');
    h.script(subOf('K2', 'a'), { text: 'stuck\nREINS: blocked: no api' }, done('fixed'));
    h.script(subOf('K2', 'b'), done('beta'));
    const run = mk(h, STACK2);
    const driven = drive(run);
    await until(paused(run, 'a'));
    await until(() => run.ended.some((e) => e.key === 'b'));
    const paused0 = JSON.parse(JSON.stringify(run.snapshot())) as RunSnapshot;
    await finish(run, driven);

    const h1 = m2harness('K2');
    const mid = back(paused0, h1);
    mid.resume('a', 'try the other API');
    const snap = JSON.parse(JSON.stringify(mid.snapshot())) as RunSnapshot;
    expect(snap.tracks!.find((t) => t.key === 'a')!.notes).toEqual(['try the other API']);
    await mid.close();

    const h2 = m2harness('K2');
    h2.script(subOf('K2', 'a'), done('fixed'));
    const again = back(snap, h2);
    await drive(again);
    expect(h2.stats(subOf('K2', 'a')).texts[0]).toContain('try the other API');
    await again.close();

    (snap.tracks!.find((t) => t.key === 'a') as { notes?: unknown }).notes = [5];
    expect(() => back(snap, m2harness('K2'))).toThrow('has notes that are not texts');
  });

  it('a stop drops every track\'s pending change request', async () => {
    const h = m2harness('K3');
    h.script(subOf('K3', 'g2'), capped(0.2));
    const run = mk(h, GATES2, { usd: 0.1 });
    const driven = drive(run);
    await until(paused(run, 'g1', 'g2'));
    await run.requestChanges('x', 'g2');
    expect(run.tracks.get('g2')!.changeRequest).toBeDefined();
    await finish(run, driven);
    expect(run.tracks.get('g2')!.changeRequest).toBeUndefined();
  });
});
