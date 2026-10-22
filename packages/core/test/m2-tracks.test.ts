// M2 task 8: the scheduler. The toy `split` (fixtures/split.ts) starts tracks with `vm.tracks.start` and collects them with `take`; the run steps every
// track at once, parks the one that waits, and Stop and close reach every track's session. Money, own-session policy, cards, snapshots and the
// per-track answers API are later tasks and are not tested here.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { validate } from '../src/validate.js';
import { Run, type RunOptions, type SubagentOpen, type Track } from '../src/run.js';
import { register } from '../src/nodes/index.js';
import type { ScriptedTurn } from '../src/fake-engine.js';
import type { Workflow } from '../src/model.js';
import { driveRun, parseAnswer, type DriveIo, type Question } from '../../server/src/drive.js';
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

// [SPLIT, TURN main, END, TURN a, END, TURN b, END, END]: the stack is `main`, the branches are `a` and `b`.
const STACK2 = '## split\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## end\n\n## phase b\n> b\n\n## end';
const VERIFY2 = '## split\nnext: v1\nnext: v2\n\n## phase main\n> m\n\n## end\n\n## verify\nid: v1\n\n## end\n\n## verify\nid: v2\n\n## end';
// The main line ends right under the split: only the parking keeps it from finishing the run.
const ONE = '## split\nnext: a\n\n## end\n\n## phase a\n> a\n\n## end';

type Harness = ReturnType<typeof m2harness>;
const mk = (h: Harness, body: string, opts: Partial<RunOptions> = {}) =>
  new Run({ workflow: wf(body), engine: h.engine, openSubagent: h.openSubagent, now: h.now, ...opts });
const done = (text: string): ScriptedTurn => ({ text: `${text}\nREINS: done` });
const mainOf = (s: string) => `${s}-main-1`;
const subOf = (s: string, key: string) => `${s}-sub-${key}`;

const drive = (run: Run) => (async () => { for (let k = 0; k < 50 && run.status === 'running'; k++) await run.step(); })();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean) => { for (let k = 0; k < 400 && !f(); k++) await sleep(5); expect(f()).toBe(true); };
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => 'timeout' as const)]);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => (resolve = r)); return { promise, resolve }; };
const named = (run: Run, type: string) => run.getEvents().filter((e) => e.type === type);
/** A live track put straight into the run, the way a test makes the main line and a track run at once (an op parks its own track, so it cannot). */
const addTrack = (run: Run, key: string, at: number): Track => {
  const t: Track = { key, title: key, parent: '', group: '', pc: at, state: 'running', turnInFlight: false, capped: false, handback: [], policy: { mode: 'write', guards: [], allowShell: true }, recall: [] };
  run.tracks.set(key, t);
  return t;
};

describe('tracks run at once', () => {
  it('two VERIFY tracks both start before either ends; each ends its own session; the main line has not started', async () => {
    const h = m2harness('T1');
    const hA = h.hold(subOf('T1', 'v1')), hB = h.hold(subOf('T1', 'v2'));
    const run = mk(h, VERIFY2);
    const driven = drive(run);
    await Promise.all([hA.started, hB.started]);
    const evs = run.getEvents();
    expect(evs.filter((e) => e.type === 'turn_started').map((e) => e.data.track)).toEqual(['v1', 'v2']);
    expect(evs.some((e) => e.type === 'turn_ended')).toBe(false);
    expect(h.opened).toEqual([subOf('T1', 'v1'), subOf('T1', 'v2')]);   // the main session never opened
    expect(h.subagentOpens.map((o) => o.step)).toEqual(['v1', 'v2']);
    hA.release();
    hB.release();
    await driven;
    expect(run.status).toBe('done');
    expect(run.ended.map((e) => e.key).sort()).toEqual(['v1', 'v2']);
    expect(run.tracks.size).toBe(0);
    // closed by the track's end, before anyone calls close()
    expect(h.stats(subOf('T1', 'v1')).closed).toBe(1);
    expect(h.stats(subOf('T1', 'v2')).closed).toBe(1);
    await run.close();
  });

  it('the step under the split runs only after take, and its turn carries both results in start order; track rows carry the key, main rows do not', async () => {
    const h = m2harness('T2');
    h.script(subOf('T2', 'a'), done('alpha'));
    h.script(subOf('T2', 'b'), done('beta'));
    const hA = h.hold(subOf('T2', 'a')), hB = h.hold(subOf('T2', 'b'));
    const run = mk(h, STACK2);
    const driven = drive(run);
    await Promise.all([hA.started, hB.started]);
    hB.release();   // b ends first, a last: the order of the results is the start order
    await until(() => run.ended.length === 1);
    await sleep(20);
    expect(h.stats(mainOf('T2')).texts).toEqual([]);   // one track is still live: the step under the split has not run
    hA.release();
    await driven;
    expect(run.status).toBe('done');
    const [text] = h.stats(mainOf('T2')).texts;
    expect(h.stats(mainOf('T2')).texts).toHaveLength(1);
    expect(text).toContain('Result of a: alpha');
    expect(text).toContain('Result of b: beta');
    expect(text!.indexOf('Result of a:')).toBeLessThan(text!.indexOf('Result of b:'));
    const evs = run.getEvents();
    const at = (type: string, track?: string) => evs.findIndex((e) => e.type === type && e.data.track === track);
    expect(at('track_started', 'b')).toBeLessThan(at('split_started'));   // the tracks exist, then the op says so
    expect(named(run, 'track_started').map((e) => e.data)).toEqual([
      { track: 'a', parent: '', group: 'split-1', title: 'Split split-1' },
      { track: 'b', parent: '', group: 'split-1', title: 'Split split-1' },
    ]);
    expect(named(run, 'track_ended').map((e) => e.data.track)).toEqual(['b', 'a']);
    expect(named(run, 'track_ended').find((e) => e.data.track === 'a')!.data).toEqual({ track: 'a', group: 'split-1', title: 'Split split-1', text: 'alpha', cost: 0 });
    expect(at('track_ended', 'a')).toBeLessThan(at('split_done'));
    expect(at('split_done')).toBeLessThan(at('turn_started'));   // the main line's turn: no track key
    expect(evs.filter((e) => e.data.track === undefined && ['turn_started', 'turn_ended'].includes(e.type))).toHaveLength(2);
    expect(evs.filter((e) => e.data.track !== undefined).every((e) => ['a', 'b'].includes(e.data.track))).toBe(true);
    await run.close();
  });

  it('the main END cannot run while a track is live', async () => {
    const h = m2harness('T3');
    const hA = h.hold(subOf('T3', 'a'));
    const run = mk(h, ONE);
    const driven = drive(run);
    await hA.started;
    await sleep(30);
    expect(run.status).toBe('running');
    expect(named(run, 'run_finished')).toEqual([]);
    expect(run.tracks.size).toBe(1);
    hA.release();
    await driven;
    expect(run.status).toBe('done');
    expect(named(run, 'run_finished')).toHaveLength(1);
    await run.close();
  });

  it('when the last track ends while the main line is in flight, no second main instruction starts', async () => {
    const h = m2harness('T4');
    const hold = h.hold(mainOf('T4'));
    const run = mk(h, '## phase one\n> 1\n\n## phase two\n> 2\n\n## end');   // [TURN one, TURN two, END, END]
    addTrack(run, 'X', 2);   // X runs the END and ends at once
    const driven = drive(run);
    await hold.started;
    await until(() => run.ended.length === 1);
    await sleep(30);   // the driver has called step() again: no track is live, the main line's first instruction is still in flight
    expect(run.tracks.size).toBe(0);
    expect(h.stats(mainOf('T4')).texts).toHaveLength(1);
    expect(named(run, 'turn_started')).toHaveLength(1);
    hold.release();
    await driven;
    expect(run.status).toBe('done');
    expect(h.stats(mainOf('T4')).texts).toHaveLength(2);
    await run.close();
  });

  it('a split inside a repeat starts fresh tracks each pass', async () => {
    const h = m2harness('T5R');
    h.script(subOf('T5R', 'a'), done('again'));
    let judged = 0;
    const run = mk(h, '## repeat\nid: loop\nuntil: llm says "done"\nmax: 5\n\n### split\nnext: a\n\n### phase after\n> after\n\n## end\n\n## phase a\n> a\n\n## end',
      { judge: async () => ++judged >= 2 });
    await drive(run);
    expect(run.status).toBe('done');
    expect(named(run, 'track_started')).toHaveLength(2);
    expect(named(run, 'track_ended')).toHaveLength(2);
    expect(run.ended.map((e) => e.key)).toEqual(['a', 'a']);
    expect(run.tracks.size).toBe(0);
    expect(h.stats(subOf('T5R', 'a')).opened).toBe(2);   // a new session each pass
    expect(h.stats(subOf('T5R', 'a')).closed).toBe(2);
    const texts = h.stats(mainOf('T5R')).texts;
    expect(texts).toHaveLength(2);
    for (const t of texts) expect(t.match(/Result of a: again/g)).toHaveLength(1);   // each pass gets its own tracks' result, once
    await run.close();
  });
});

describe('the loop wakes', () => {
  it('an invalid answer to a track gate wakes the loop (poke)', async () => {
    const h = m2harness('T6');
    const run = mk(h, '## split\nnext: g\n\n## end\n\n## gate\nid: g\nuntil: you approve\n\n## end');
    await run.step();   // the split starts g
    await run.step();   // g's gate pauses g; the run itself keeps running
    const g = run.tracks.get('g')!;
    expect(g.state).toBe('paused');
    expect(g.pause?.type).toBe('gate');
    expect(run.status).toBe('running');
    let woke = false;
    const asleep = run.step().then(() => { woke = true; });   // every track idle or parked: step() sleeps
    await sleep(30);
    expect(woke).toBe(false);
    // what a driver does for a track's question: ask, and when it settles, poke (an invalid answer changes nothing in the run)
    const said: string[] = [];
    let answer!: (a: string | null) => void;
    const io: DriveIo = { ask: (_q: Question) => new Promise((res) => { answer = res; }), say: (l) => { said.push(l); }, write: () => {} };
    const asking = io.ask({ id: 'q', kind: 'gate', prompt: 'approve / changes <note> / stop', title: g.title }).then((a) => {
      const ans = parseAnswer('gate', a ?? '');
      if (ans.t === 'invalid') io.say(ans.hint);
      run.poke();
    });
    answer('maybe');
    await asking;
    expect(await within(asleep, 1000)).toBeUndefined();
    expect(woke).toBe(true);
    expect(said).toEqual(['Type approve, changes <note>, or stop.']);
    expect(g.state).toBe('paused');   // the invalid answer changed nothing
    await run.stop();
    await run.close();
  });
});

describe('a throw', () => {
  it('a non-main throw pauses only that track; the other track and the run go on; its session is closed', async () => {
    const h = m2harness('T7');
    h.script(subOf('T7', 'b'), done('fine'));
    const hA = h.hold(subOf('T7', 'a')), hB = h.hold(subOf('T7', 'b'));
    const run = mk(h, STACK2);
    const driven = drive(run);
    await Promise.all([hA.started, hB.started]);
    hA.fail(new Error('boom'));
    hB.release();
    await until(() => run.tracks.get('a')?.state === 'paused');
    const a = run.tracks.get('a')!;
    expect(a.pause).toEqual({ type: 'stop', stepId: 'a', text: 'Split split-1 failed: boom; Resume tries again' });
    expect(run.status).toBe('running');
    expect(run.pauseReason).toBeUndefined();
    await until(() => run.ended.length === 1);
    expect(run.ended.map((e) => e.key)).toEqual(['b']);
    expect(named(run, 'run_paused').map((e) => e.data)).toEqual([{ reason: 'stop', text: 'Split split-1 failed: boom; Resume tries again', stepId: 'a', track: 'a' }]);
    expect(h.stats(mainOf('T7')).texts).toEqual([]);   // the main line is parked behind a
    expect(h.stats(subOf('T7', 'a')).closed).toBe(1);
    // every track idle or parked: step() sleeps; Stop wakes it
    await sleep(30);
    await run.stop();
    expect(await within(driven, 1000)).toBeUndefined();
    await run.close();
  });

  it('a main throw reaches driveRun', async () => {
    const h = m2harness('T8');
    h.hold(mainOf('T8')).fail(new Error('boom'));
    const hX = h.hold(subOf('T8', 'X'));
    const run = mk(h, '## phase one\n> 1\n\n## end');   // [TURN one, END, END]
    addTrack(run, 'X', 0);   // a live track, so the main line runs under the scheduler
    const said: string[] = [];
    const io: DriveIo = { ask: async () => null, say: (l) => { said.push(l); }, write: () => {} };
    const r = await within(driveRun(run, io, () => {}), 2000);
    expect(r).toEqual({ result: 'detached', error: 'boom' });
    expect(said).toEqual(['✗ boom']);
    // driveRun closed the run, which closed the track's session (or the opener's caller did, when the close came first)
    expect(h.stats(subOf('T8', 'X')).opened).toBe(1);
    expect(h.stats(subOf('T8', 'X')).closed).toBe(1);
    void hX;
  });
});

describe('Stop and close', () => {
  it('Stop with two held turns interrupts both, close() returns, and no turn starts after it', async () => {
    const h = m2harness('T9');
    const hA = h.hold(subOf('T9', 'a')), hB = h.hold(subOf('T9', 'b'));
    const run = mk(h, STACK2);
    const driven = drive(run);
    await Promise.all([hA.started, hB.started]);
    await run.stop();
    expect(h.stats(subOf('T9', 'a')).interrupts).toBe(1);
    expect(h.stats(subOf('T9', 'b')).interrupts).toBe(1);
    await driven;
    expect(await within(run.close(), 2000)).toBeUndefined();
    const evs = run.getEvents();
    expect(evs.slice(evs.findIndex((e) => e.type === 'run_stopped')).filter((e) => e.type === 'turn_started')).toEqual([]);
    expect(run.status).toBe('stopped');
    expect(h.stats(subOf('T9', 'a')).closed).toBe(1);
    expect(h.stats(subOf('T9', 'b')).closed).toBe(1);
    expect(h.stats(mainOf('T9')).texts).toEqual([]);
  });

  it('Stop while a track session opens closes the new session, and sends nothing', async () => {
    const h = m2harness('T10');
    const opening = deferred(), letOpen = deferred();
    const openSubagent = async (o: SubagentOpen) => { opening.resolve(); await letOpen.promise; return h.openSubagent(o); };
    const run = mk(h, ONE, { openSubagent });
    const driven = drive(run);
    await opening.promise;
    await run.stop();
    letOpen.resolve();
    await driven;
    await until(() => h.stats(subOf('T10', 'a')).closed === 1);
    expect(h.stats(subOf('T10', 'a')).opened).toBe(1);
    expect(h.stats(subOf('T10', 'a')).texts).toEqual([]);
    expect(run.tracks.get('a')?.state).toBe('running');   // a stopped run does not pause the track for the "closed" it threw
    expect(run.tracks.get('a')?.session).toBeUndefined();
    await run.close();
    expect(h.stats(subOf('T10', 'a')).closed).toBe(1);
  });

  it('close() after no Stop (a detach) closes every track session, waits for every instruction, and leaves the tracks running', async () => {
    const h = m2harness('T11');
    const hA = h.hold(subOf('T11', 'a')), hB = h.hold(subOf('T11', 'b'));
    // a's engine takes a while to unwind a turn that was closed under it; b's does not
    const openSubagent = async (o: SubagentOpen) => {
      const r = await h.openSubagent(o);
      const turn = r.session.turn.bind(r.session);
      return { ...r, session: { ...r.session, turn: async (t: string) => { try { return await turn(t); } catch (e) { if (o.step === 'a') await sleep(40); throw e; } } } };
    };
    const run = mk(h, STACK2, { openSubagent });
    await run.step();   // the split starts a and b
    const first = run.step();
    await Promise.all([hA.started, hB.started]);
    const a = run.tracks.get('a')!, b = run.tracks.get('b')!;
    const closing = run.close();
    await first;   // b unwound at once; a is still unwinding
    const second = run.step();   // the run is closing: b must not start again
    await closing;
    expect(a.inflight).toBeUndefined();   // close() waited for a
    for (const t of [a, b]) expect(t.state).toBe('running');   // no pause for the "closed": they run again after a restore
    expect(named(run, 'run_paused')).toEqual([]);
    await second;
    for (const key of ['a', 'b']) {
      expect(h.stats(subOf('T11', key)).opened).toBe(1);
      expect(h.stats(subOf('T11', key)).closed).toBe(1);
    }
  });
});

describe('the group API of vm.tracks', () => {
  const spec = (key: string, at = 0) => ({ key, at, title: key });
  it('take gives nothing until every track of the group ended, then the results in start order, once', () => {
    const run = mk(m2harness('G1'), STACK2) as any;
    run.startTracks(run.main, 'g', [spec('a'), spec('b')]);
    run.groups.get('g').results.set('b', { key: 'b', title: 'b', text: 'B', cost: 0 });
    expect(run.takeTracks('g')).toBeUndefined();
    run.groups.get('g').results.set('a', { key: 'a', title: 'a', text: 'A', cost: 0 });
    expect(run.takeTracks('g').map((r: { key: string }) => r.key)).toEqual(['a', 'b']);
    expect(run.takeTracks('g')).toBeUndefined();
  });

  it('start refuses a live group, a key already live, the main key and a repeated key, and starts nothing', () => {
    const run = mk(m2harness('G2'), STACK2) as any;
    run.startTracks(run.main, 'g', [spec('a')]);
    expect(() => run.startTracks(run.main, 'g', [spec('c')])).toThrow('group "g" is live');
    expect(() => run.startTracks(run.main, 'h', [spec('a')])).toThrow('track "a" is live');
    expect(() => run.startTracks(run.main, 'h', [spec('')])).toThrow('track "" is live');
    expect(() => run.startTracks(run.main, 'h', [spec('x'), spec('x')])).toThrow('track "x" is live');
    expect([...run.tracks.keys()]).toEqual(['a']);
    expect(run.groups.has('h')).toBe(false);
  });
});

describe('edit', () => {
  it('with a live track gives the run its step-deleted pause and applies nothing; with none it is as before', async () => {
    const h = m2harness('T12');
    const hA = h.hold(subOf('T12', 'a'));
    const original = wf(ONE);
    const run = mk(h, ONE, { workflow: original });
    const driven = drive(run);
    await hA.started;
    run.edit(wf(STACK2));
    expect(run.status).toBe('paused');
    expect(run.pauseReason).toEqual({ type: 'step-deleted' });
    expect(run.workflow).toBe(original);
    await driven;   // the pause woke the loop
    await run.stop();
    await run.close();

    const plain = mk(m2harness('T12b'), '## phase one\n> 1\n\n## end');
    const next = wf('## phase one\n> 1\n\n## phase two\n> 2\n\n## end');
    plain.edit(next);
    expect(plain.status).toBe('running');
    expect(plain.workflow).toBe(next);
  });
});
