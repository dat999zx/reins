// M2 task 10a: a track has its OWN session and its own USD slice; cards and autos reach only the main line; a track has no host switch.
// The toy `split` (fixtures/split.ts) starts the tracks. Money records, per-track pauses and the answers API are later tasks and are not tested here.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { validate } from '../src/validate.js';
import { Run, type RunOptions, type RunSnapshot, type Track } from '../src/run.js';
import { register } from '../src/nodes/index.js';
import type { OpenOptions } from '../src/fake-engine.js';
import type { Workflow } from '../src/model.js';
import { m2harness } from './m2-harness.js';
import { split } from './fixtures/split.js';

const disposers: Array<() => void> = [];
beforeAll(() => { disposers.push(register(split)); });
afterAll(() => { for (const d of disposers.splice(0).reverse()) d(); });

const wf = (body: string): Workflow => {
  const r = parseWorkflow(`---\nreins: 1\nname: t\nbudget: { turns: 40, minutes: 60 }\nalways: []\n---\n\n${body}\n`);
  expect(r.diagnostics).toEqual([]);
  expect(validate(r.workflow!).filter((d) => d.severity === 'error').map((d) => d.message)).toEqual([]);
  return r.workflow!;
};

// [SPLIT, TURN main, END, TURN a, TURN a2, END, TURN b, TURN b2, END, END]: each branch has two turns.
const TWO_TURNS = '## split\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## phase a2\n> a2\n\n## end\n\n## phase b\n> b\n\n## phase b2\n> b2\n\n## end';
const ONE = '## split\nnext: a\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## end';

type Harness = ReturnType<typeof m2harness>;
const mk = (h: Harness, body: string, opts: Partial<RunOptions> = {}) =>
  new Run({ workflow: wf(body), engine: h.engine, openSubagent: h.openSubagent, now: h.now, ...opts });
const mainOf = (s: string) => `${s}-main-1`;
const subOf = (s: string, key: string) => `${s}-sub-${key}`;

const drive = (run: Run) => (async () => { for (let k = 0; k < 50 && run.status === 'running'; k++) await run.step(); })();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean) => { for (let k = 0; k < 400 && !f(); k++) await sleep(5); expect(f()).toBe(true); };
const named = (run: Run, type: string) => run.getEvents().filter((e) => e.type === type);
const ownerOf = (run: Run) => run as unknown as { vm(t: Track): { ensureSession(): Promise<{ sessionId: string }> } };

describe('a track opens its own session through the opener', () => {
  it('each session is opened with step = key, asks = title, its policy and no model', async () => {
    const h = m2harness('O1');
    const hA = h.hold(subOf('O1', 'a')), hB = h.hold(subOf('O1', 'b'));
    const run = mk(h, TWO_TURNS);
    const driven = drive(run);
    await Promise.all([hA.started, hB.started]);
    expect(h.subagentOpens.map((o) => ({ step: o.step, title: o.title, asks: o.asks, model: 'model' in o }))).toEqual([
      { step: 'a', title: 'Split split-1', asks: 'Split split-1', model: false },
      { step: 'b', title: 'Split split-1', asks: 'Split split-1', model: false },
    ]);
    expect(h.subagentOpens.every((o) => typeof o.policy === 'function')).toBe(true);
    hA.release();
    hB.release();
    await driven;
    await run.close();
  });

  it('asks does not reach engine.open when the run opens the session itself (the terminal path)', async () => {
    const h = m2harness('O2');
    const seen: OpenOptions[] = [];
    const engine = { ...h.engine, open: async (o: OpenOptions) => { seen.push(o); return h.engine.open(o); } };
    const run = mk(h, ONE, { engine, openSubagent: undefined });
    await drive(run);
    expect(run.status).toBe('done');
    expect(seen).toHaveLength(2);   // the track's session, then the main line's
    for (const o of seen) {
      expect('asks' in o).toBe(false);
      expect('step' in o).toBe(false);
      expect('title' in o).toBe(false);
    }
    await run.close();
  });

  it('policy() during a track turn is the main line\'s; the track session\'s policy closure gives the track\'s', async () => {
    const h = m2harness('P1');
    const hold = h.hold(subOf('P1', 'a'));
    const run = mk(h, '## split\nnext: a\n\n## phase main\n> m\n\n## end\n\n## phase a\nmode: read-only\n> a\n\n## end');
    const driven = drive(run);
    await hold.started;
    expect(run.policy()).toEqual({ mode: 'write', guards: [], allowShell: true });
    expect(h.subagentOpens[0]!.policy().mode).toBe('read-only');
    hold.release();
    await driven;
    await run.close();
  });

  it('carry item 1: with a borrowed main session, the track\'s own session opens, with the track\'s resume id', async () => {
    const h = m2harness('C1');
    const borrowed = await h.engine.open({ policy: () => ({ mode: 'write', guards: [], allowShell: true }) });
    const run = mk(h, ONE, { session: borrowed });
    const t: Track = { key: 'x', title: 'Branch x', parent: '', group: '', pc: 0, state: 'running', turnInFlight: false, capped: false, handback: [], policy: { mode: 'write', guards: [], allowShell: true }, recall: [], sessionId: 'C1-saved-x' };
    run.tracks.set('x', t);
    const own = await ownerOf(run).vm(t).ensureSession();
    expect(own).not.toBe(borrowed);
    expect(own.sessionId).toBe('C1-saved-x');
    expect(h.subagentOpens).toHaveLength(1);
    expect(h.subagentOpens[0]!.sessionId).toBe('C1-saved-x');
    expect(await ownerOf(run).vm(run.main).ensureSession()).toBe(borrowed);   // the main line still uses the one it was lent
    await run.close();
  });
});

describe('a subagent step and a model step on a track', () => {
  const BODY = '## split\nnext: model-1\n\n## phase main\n> m\n\n## end\n\n## model claude-x\nusd: 0.40\n\n## subagent research\nmodel: m1\n> Look.\n\n## end';

  it('opens its own session, counts to the track\'s slice, hands its result back into the track', async () => {
    const h = m2harness('S1');
    h.script(subOf('S1', 'subagent-1'), { text: 'found it\nREINS: done', cost: 0.06 });
    const seen: Array<{ mainSlice: unknown; trackHandback: string[]; mainHandback: unknown }> = [];
    const ref: { run?: Run } = {};
    const run = (ref.run = mk(h, BODY, {
      onEvent: (ev) => {
        if (ev.type !== 'subagent_result') return;
        const snap = ref.run!.snapshot();
        seen.push({ mainSlice: snap.openSlice, trackHandback: snap.tracks![0]!.handback, mainHandback: snap.handback });
      },
    }));
    await drive(run);
    expect(run.status).toBe('done');
    expect(h.subagentOpens.map((o) => o.step)).toEqual(['subagent-1']);   // the track's own session was never needed
    expect(h.opened).toEqual([subOf('S1', 'subagent-1'), mainOf('S1')]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.mainSlice).toBeUndefined();   // the model step opened the TRACK's slice, not the main line's
    expect(seen[0]!.trackHandback).toHaveLength(1);
    expect(seen[0]!.trackHandback[0]).toContain('Result of subagent "research" (step subagent-1)');
    expect(seen[0]!.mainHandback).toBeUndefined();
    expect(run.snapshot().usdSpent).toEqual({ 'model-1': 0.06 });
    const ended = named(run, 'turn_ended').find((e) => e.data.track === 'model-1')!;
    expect(ended.data.slice).toEqual({ step: 'model-1', spent: 0.06, usd: 0.4 });
    expect(run.ended[0]!.text).toContain('Result of subagent "research" (step subagent-1)');
    expect(h.stats(mainOf('S1')).texts[0]).toContain('Result of model-1:');   // the track's result reaches the main line only through the split
    await run.close();
  });

  it('a plain turn on a track counts to the track\'s slice; the main line\'s turn after the split has none', async () => {
    const h = m2harness('S3');
    h.script(subOf('S3', 'model-1'), { text: 'ok\nREINS: done', cost: 0.06 });
    const run = mk(h, '## split\nnext: model-1\n\n## phase main\n> m\n\n## end\n\n## model claude-x\nusd: 0.40\n\n## phase a\n> a\n\n## end');
    await drive(run);
    expect(run.status).toBe('done');
    expect(run.snapshot().usdSpent).toEqual({ 'model-1': 0.06 });
    expect(run.snapshot().openSlice).toBeUndefined();
    const ends = named(run, 'turn_ended');
    expect(ends.find((e) => e.data.track === 'model-1')!.data.slice).toEqual({ step: 'model-1', spent: 0.06, usd: 0.4 });
    expect(ends.find((e) => e.data.track === undefined)!.data.slice).toBeUndefined();
    await run.close();
  });

  it('a track copies its starter\'s open slice, and keeps it in a snapshot', async () => {
    const h = m2harness('S2');
    const hold = h.hold(subOf('S2', 'a'));
    const run = mk(h, '## model claude-x\nusd: 0.40\n\n' + ONE);
    const driven = drive(run);
    await hold.started;
    const snap = run.snapshot();
    expect(snap.openSlice).toEqual({ step: 'model-1', usd: 0.4 });
    expect(snap.tracks![0]!.openSlice).toEqual({ step: 'model-1', usd: 0.4 });
    const back = Run.restore(JSON.parse(JSON.stringify(snap)) as RunSnapshot, { engine: h.engine, openSubagent: h.openSubagent, now: h.now });
    expect(back.tracks.get('a')!.openSlice).toEqual({ step: 'model-1', usd: 0.4 });
    hold.release();
    await driven;
    await run.close();
    await back.close();
  });

  it('a model step on a track gets no switch: it logs how: unsupported; the main line\'s own model step still switches', async () => {
    const h = m2harness('M1');
    const calls: Array<[string, string]> = [];
    const levels: string[] = [];
    const run = mk(h, '## model claude-y\n\n## split\nnext: model-2\n\n## end\n\n## model claude-x\nreasoning: high\n\n## end', {
      switchModel: async (model, step) => { calls.push([model, step]); return { to: 'switched', label: 'L' }; },
      setReasoning: (level) => { levels.push(level); },
    });
    await drive(run);
    expect(run.status).toBe('done');
    expect(calls).toEqual([['claude-y', 'model-1']]);
    expect(levels).toEqual([]);
    expect(named(run, 'model_switched').map((e) => e.data)).toEqual([
      { step: 'model-1', model: 'claude-y', how: 'switched', label: 'L' },
      { step: 'model-2', model: 'claude-x', how: 'unsupported', track: 'model-2' },
    ]);
    await run.close();
  });
});

describe('cards and autos reach only the main line', () => {
  it('a now card typed while two tracks run lands in the turn under the split, not in a branch\'s second turn', async () => {
    const h = m2harness('K1');
    const hA = h.hold(subOf('K1', 'a')), hB = h.hold(subOf('K1', 'b'));
    const run = mk(h, TWO_TURNS);
    const driven = drive(run);
    await Promise.all([hA.started, hB.started]);
    run.queueCard('CARD-NOW', 'now');
    hA.release();
    hB.release();
    await driven;
    expect(run.status).toBe('done');
    for (const key of ['a', 'b']) {
      const texts = h.stats(subOf('K1', key)).texts;
      expect(texts).toHaveLength(2);
      expect(texts.some((x) => x.includes('CARD-NOW'))).toBe(false);
    }
    expect(h.stats(mainOf('K1')).texts).toHaveLength(1);
    expect(h.stats(mainOf('K1')).texts[0]).toContain('CARD-NOW');
    expect(named(run, 'card_delivered').map((e) => ({ card: e.data.card, track: e.data.track }))).toEqual([{ card: 'CARD-NOW', track: undefined }]);
    await run.close();
  });

  it('a resumed subagent inside a branch does not take pendingCards', async () => {
    const h = m2harness('K2');
    h.script(subOf('K2', 'subagent-1'), { text: 'half', isError: true, cost: 0.02 });   // counted, then an error: the step pauses and can be resumed
    const run = mk(h, '## split\nnext: subagent-1\n\n## phase main\n> m\n\n## end\n\n## subagent research\nmodel: m1\n> Look.\n\n## end');
    const driven = drive(run);
    const t = () => run.tracks.get('subagent-1')!;
    await until(() => t().state === 'paused');
    run.queueCard('NOTE-FOR-MAIN', 'steer');
    t().state = 'running';   // the per-track Resume is Task 11; this is its effect
    t().pause = undefined;
    run.poke();
    await until(() => h.stats(subOf('K2', 'subagent-1')).texts.length === 2);
    expect(h.stats(subOf('K2', 'subagent-1')).texts[1]).not.toContain('NOTE-FOR-MAIN');
    expect(run.snapshot().pendingCards).toEqual(['NOTE-FOR-MAIN']);
    await until(() => t().state === 'paused');
    await run.stop();
    await run.close();
    await driven;
  });

  it('an auto card does not fire after a track\'s turn; it does after a main-line turn', async () => {
    const h = m2harness('A1');
    const base = wf(ONE);
    const workflow: Workflow = { ...base, autos: [{ id: 'w', cond: { t: 'diff', n: 0 }, card: { kind: 'now', text: 'AUTO' } }] };
    const run = new Run({ workflow, engine: h.engine, openSubagent: h.openSubagent, now: h.now, diffLines: async () => 5 });
    await drive(run);
    expect(run.status).toBe('done');
    const evs = run.getEvents();
    const queued = evs.filter((e) => e.type === 'card_queued');
    expect(queued.map((e) => ({ card: e.data.card, source: e.data.source, track: e.data.track }))).toEqual([{ card: 'AUTO', source: 'auto', track: undefined }]);
    const mainEnded = evs.findIndex((e) => e.type === 'turn_ended' && e.data.track === undefined);
    expect(mainEnded).toBeGreaterThan(-1);
    expect(evs.indexOf(queued[0]!)).toBeGreaterThan(mainEnded);   // after the main line's turn, none after the track's earlier one
    await run.close();
  });
});

describe('the slice of a track is what stops it', () => {
  const spent = () => {
    const run = mk(m2harness('U1'), ONE) as any;
    const t = { key: 'a', title: 'a', parent: '', group: '', pc: 3, state: 'running', turnInFlight: false, capped: false, handback: [], policy: { mode: 'write', guards: [], allowShell: true }, recall: [], openSlice: { step: 's', usd: 0.01 } } as Track;
    run.tracks.set('a', t);
    run.usdSpent.s = 0.02;   // the track's slice is used up; the main line has none open
    return { run, t };
  };

  it('a track whose slice is used up stops the run at its next instruction (the main line has no slice)', async () => {
    const { run, t } = spent();
    await run.stepTrack(t);
    expect(run.status).toBe('paused');
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', stepId: 's' });
  });

  it('guardUsd judges the reply of a track by the slice of the track', () => {
    const { run, t } = spent();
    expect(run.guardUsd(t, { text: 'ok' })).toBe(true);
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', stepId: 's' });
  });
});
