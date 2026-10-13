// A run executes NODE steps through the kind's exec and enforces USD after each reply (milestone C, Task 2).
import { describe, it, expect } from 'vitest';
import { Run, type RunSnapshot } from '../src/run.js';
import { FakeEngine, type Engine, type OpenOptions, type ScriptedTurn, type TurnResult } from '../src/fake-engine.js';
import type { SwitchOutcome } from '../src/nodes/index.js';
import { parseWorkflow } from '../src/index.js';
import type { Step, Workflow } from '../src/model.js';

const step = (id: string, kind: Step['kind'], over: Partial<Step> = {}): Step => ({ id, kind, attrs: {}, cards: [], links: [], ...over });
const phase = (id: string) => step(id, 'phase', { title: id, prompt: 'do it' });
const model = (id: string, attrs: Record<string, string> = { model: 'claude-x' }) => step(id, 'model', { attrs });
const wf = (steps: Step[], usd: number | undefined = 2): Workflow => ({
  version: 1, name: 't', budget: { turns: 50, minutes: 50, ...(usd === undefined ? {} : { usd }) }, always: [], steps, autos: [],
});
const costs = (...c: Array<number | undefined>): ScriptedTurn[] => c.map((cost) => ({ text: 'REINS: done', ...(cost === undefined ? {} : { cost }) }));
const switched = (calls: Array<[string, string]> = []) => async (m: string, s: string): Promise<SwitchOutcome> => {
  calls.push([m, s]);
  return { to: 'switched', label: m };
};
const go = async (run: Run) => { while (run.status === 'running') await run.step(); return run; };
const named = (run: Run, type: string) => run.getEvents().filter((e) => e.type === type);

describe('USD slices on a model step', () => {
  it('a reply that passes the slice pauses before the next step, never after the last one', async () => {
    const done = new Run({ workflow: wf([model('model-1', { model: 'claude-x', usd: '0.10' }), phase('a'), phase('b')]), engine: new FakeEngine(costs(0.06, 0.06)), switchModel: switched() });
    await go(done);
    expect(done.status).toBe('done');
    expect(named(done, 'budget_reached')).toEqual([]);

    const run = new Run({ workflow: wf([model('model-1', { model: 'claude-x', usd: '0.10' }), phase('a'), phase('b'), phase('c')]), engine: new FakeEngine(costs(0.06, 0.06, 0.06)), switchModel: switched() });
    await go(run);
    expect(run.status).toBe('paused');
    expect(run.pauseReason).toEqual({ type: 'usd-budget-used', stepId: 'model-1', limit: 0.1, spent: 0.12 });
    expect(named(run, 'budget_reached').map((e) => e.data)).toEqual([{ step: 'model-1', usd: 0.1, spent: 0.12 }]);
    const spent = named(run, 'engine_cost').reduce((a, e) => a + e.data.usd, 0);
    expect(spent).toBeCloseTo(0.12, 9);
    expect(named(run, 'turn_ended').map((e) => e.data.slice)).toEqual([
      { step: 'model-1', spent: 0.06, usd: 0.1 },
      { step: 'model-1', spent: 0.12, usd: 0.1 },
    ]);
  });

  it('allowUsd(n) means n more from now: the next check uses what was spent plus n', async () => {
    const run = new Run({ workflow: wf([model('model-1', { model: 'claude-x', usd: '0.10' }), phase('a'), phase('b'), phase('c')]), engine: new FakeEngine(costs(0.06, 0.06, 0.06)), switchModel: switched() });
    await go(run);
    expect(run.allowUsd(0.05)).toBeUndefined();
    expect(run.status).toBe('running');
    expect(named(run, 'run_resumed').at(-1)!.data).toEqual({ allowUsd: 0.05, usd: 0.17, step: 'model-1' });
    await go(run);
    // c cost 0.06: 0.18 is past 0.17, but c was the last step before END, so the run finishes
    expect(run.status).toBe('done');
  });

  it('S1: an allow always clears the current spend, so the next step runs and the following check uses the new limit', async () => {
    const run = new Run({ workflow: wf([model('model-1', { model: 'claude-x', usd: '0.50' }), phase('a'), phase('b'), phase('c')]), engine: new FakeEngine(costs(0.52, 0.01, 0.01)), switchModel: switched() });
    await go(run);
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', stepId: 'model-1', limit: 0.5, spent: 0.52 });
    expect(run.allowUsd(0.01)).toBeUndefined();
    expect(named(run, 'run_resumed').at(-1)!.data).toEqual({ allowUsd: 0.01, usd: 0.53, step: 'model-1' });
    await go(run);
    // b ran (no second pause at once); 0.52 + 0.01 = 0.53 reaches the new limit before c
    expect(run.status).toBe('paused');
    expect(run.pauseReason).toEqual({ type: 'usd-budget-used', stepId: 'model-1', limit: 0.53, spent: 0.53 });
    expect(named(run, 'turn_ended')).toHaveLength(2);
  });

  it('an allow past what the workflow has left is refused in words and the run stays paused', async () => {
    const run = new Run({ workflow: wf([model('model-1', { model: 'claude-x', usd: '0.10' }), phase('a'), phase('b'), phase('c')], 0.2), engine: new FakeEngine(costs(0.06, 0.06)), switchModel: switched() });
    await go(run);
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', stepId: 'model-1' });
    expect(run.usdLeft()).toBeCloseTo(0.08, 9);
    expect(run.allowUsd(0.1)).toBe("Allow at most $0.08: the workflow's USD budget has that much left.");
    expect(run.status).toBe('paused');
    expect(run.allowUsd(0.08)).toBeUndefined();
    expect(run.status).toBe('running');
  });

  it('with less than a cent left the allowance is capped, not refused, and the next overrun pauses on the workflow', async () => {
    const run = new Run({
      workflow: wf([model('model-1', { model: 'claude-x', usd: '0.10' }), phase('a'), phase('b'), phase('c'), phase('d')], 0.2),
      engine: new FakeEngine(costs(0.096, 0.1, 0.01)), switchModel: switched(),
    });
    await go(run);
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', stepId: 'model-1', spent: 0.196 });
    expect(run.usdLeft()).toBeCloseTo(0.004, 9);
    expect(run.allowUsd(0.01)).toBeUndefined();
    expect(run.status).toBe('running');
    expect(named(run, 'run_resumed').at(-1)!.data).toEqual({ allowUsd: 0.004, usd: 0.2, step: 'model-1' });
    await go(run);
    expect(run.pauseReason).toEqual({ type: 'usd-budget-used', limit: 0.2, spent: 0.206 });
  });

  it('the cap covers everything under a cent, not only under half a cent (0.7 of a cent left: an allowance of a cent is capped, not refused)', async () => {
    const run = new Run({
      workflow: wf([model('model-1', { model: 'claude-x', usd: '0.05' }), phase('a'), phase('b'), phase('c')], 0.2),
      engine: new FakeEngine(costs(0.193, 0.01, 0.01)), switchModel: switched(),
    });
    await go(run);
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', stepId: 'model-1', spent: 0.193 });
    expect(run.usdLeft()).toBeCloseTo(0.007, 9);
    expect(run.allowUsd(0.01)).toBeUndefined();
    expect(run.status).toBe('running');
    expect(named(run, 'run_resumed').at(-1)!.data).toEqual({ allowUsd: 0.007, usd: 0.2, step: 'model-1' });
  });

  it('a loop that passes the model step again keeps the slice spend: the second pass pauses when the sum reaches it', async () => {
    const text = '---\nreins: 1\nname: t\nbudget: { turns: 50, minutes: 50, usd: 2.00 }\nalways: []\n---\n\n' +
      '## repeat\nmax: 3\nuntil: `t` passes\n\n### model claude-x\nusd: 0.10\n\n### phase a\n> go\n';
    const parsed = parseWorkflow(text);
    expect(parsed.diagnostics).toEqual([]);
    const run = new Run({
      workflow: parsed.workflow!, engine: new FakeEngine(costs(0.06, 0.06, 0.06)), switchModel: switched(),
      commandRunner: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    });
    await go(run);
    // each pass alone spends 0.06, under the 0.10 slice; only the sum of both reaches it
    expect(named(run, 'turn_ended')).toHaveLength(2);
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', limit: 0.1, spent: 0.12 });
  });

  it('allowUsd does nothing outside a USD pause', () => {
    const run = new Run({ workflow: wf([phase('a')]), engine: new FakeEngine() });
    expect(run.allowUsd(1)).toBeUndefined();
    expect(named(run, 'run_resumed')).toEqual([]);
  });

  it("the workflow's own USD pauses with no step id, and an allow carries the new limit", async () => {
    const run = new Run({ workflow: wf([phase('a'), phase('b'), phase('c')], 0.1), engine: new FakeEngine(costs(0.06, 0.06)) });
    await go(run);
    expect(run.pauseReason).toEqual({ type: 'usd-budget-used', limit: 0.1, spent: 0.12 });
    expect(named(run, 'budget_reached').map((e) => e.data)).toEqual([{ usd: 0.1, spent: 0.12 }]);
    expect(run.usdLeft()).toBeCloseTo(-0.02, 9);
    expect(run.allowUsd(1)).toBeUndefined();
    expect(named(run, 'run_resumed').at(-1)!.data).toEqual({ allowUsd: 1, usd: 1.12 });
    expect(run.usdLeft()).toBeCloseTo(1, 9);
    await go(run);
    expect(run.status).toBe('done');
  });

  it("the workflow's limit is reached AT the limit: 0.05 + 0.05 under 0.10 pauses before the next step", async () => {
    const run = new Run({ workflow: wf([phase('a'), phase('b'), phase('c')], 0.1), engine: new FakeEngine(costs(0.05, 0.05, 0.05)) });
    await go(run);
    expect(run.status).toBe('paused');
    expect(run.pauseReason).toEqual({ type: 'usd-budget-used', limit: 0.1, spent: 0.1 });
    expect(run.snapshot().programCounter).toBe(2);
  });

  it('a slice with no workflow USD has no ceiling: usdLeft is undefined and an allow of any size is taken', async () => {
    const noUsd: Workflow = { ...wf([model('model-1', { model: 'claude-x', usd: '0.10' }), phase('a'), phase('b'), phase('c')]), budget: { turns: 50, minutes: 50 } };
    const run = new Run({ workflow: noUsd, engine: new FakeEngine(costs(0.06, 0.06, 0.06)), switchModel: switched() });
    await go(run);
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', stepId: 'model-1' });
    expect(run.usdLeft()).toBeUndefined();
    expect(run.allowUsd(5)).toBeUndefined();
    expect(run.status).toBe('running');
    expect(named(run, 'run_resumed').at(-1)!.data).toEqual({ allowUsd: 5, usd: 5.12, step: 'model-1' });
  });

  it("both limits over: the workflow's is checked first, so the pause has no step id", async () => {
    const run = new Run({ workflow: wf([model('model-1', { model: 'claude-x', usd: '0.10' }), phase('a'), phase('b'), phase('c')], 0.1), engine: new FakeEngine(costs(0.06, 0.06)), switchModel: switched() });
    await go(run);
    expect(run.pauseReason).toEqual({ type: 'usd-budget-used', limit: 0.1, spent: 0.12 });
  });

  it('a second model step without usd closes the slice: later replies count only toward the workflow', async () => {
    const run = new Run({
      workflow: wf([model('model-1', { model: 'claude-x', usd: '0.10' }), phase('a'), model('model-2', { model: 'claude-y' }), phase('b'), phase('c')]),
      engine: new FakeEngine(costs(0.06, 0.06, 0.06)), switchModel: switched(),
    });
    await go(run);
    expect(run.status).toBe('done');
    expect(named(run, 'budget_reached')).toEqual([]);
    const slices = named(run, 'turn_ended').map((e) => e.data.slice);
    expect(slices[0]).toEqual({ step: 'model-1', spent: 0.06, usd: 0.1 });
    expect(slices[1]).toBeUndefined();
    expect('slice' in named(run, 'turn_ended')[1]!.data).toBe(false);
    expect(run.snapshot().openSlice).toBeUndefined();
  });

  it('a reply with no cost counts 0 and pauses nothing', async () => {
    const run = new Run({ workflow: wf([model('model-1', { model: 'claude-x', usd: '0.01' }), phase('a'), phase('b')], 0.01), engine: new FakeEngine(costs(undefined, undefined)), switchModel: switched() });
    await go(run);
    expect(run.status).toBe('done');
    expect(run.snapshot().runCost).toBe(0);
  });
});

describe('the switch of a model step', () => {
  it('calls switchModel once with the model and the step', async () => {
    const calls: Array<[string, string]> = [];
    const run = new Run({ workflow: wf([model('model-1'), phase('a')]), engine: new FakeEngine(), switchModel: switched(calls) });
    await go(run);
    expect(calls).toEqual([['claude-x', 'model-1']]);
    expect(named(run, 'model_switched').map((e) => e.data)).toEqual([{ step: 'model-1', model: 'claude-x', how: 'switched', label: 'claude-x' }]);
  });

  it('a host without switchModel logs unsupported and goes on', async () => {
    const run = new Run({ workflow: wf([model('model-1'), phase('a')]), engine: new FakeEngine() });
    await go(run);
    expect(run.status).toBe('done');
    expect(named(run, 'model_switched').map((e) => e.data)).toEqual([{ step: 'model-1', model: 'claude-x', how: 'unsupported' }]);
  });

  it('stop outcome stops the run and leaves the counter', async () => {
    const run = new Run({ workflow: wf([model('model-1'), phase('a')]), engine: new FakeEngine(), switchModel: async () => ({ to: 'stop' }) });
    await go(run);
    expect(run.status).toBe('stopped');
    expect(run.snapshot().programCounter).toBe(0);
    expect(named(run, 'model_switched')).toEqual([]);
  });

  it('closed outcome pauses at the step and resume() asks again', async () => {
    const calls: Array<[string, string]> = [];
    const outcomes: SwitchOutcome[] = [{ to: 'closed' }, { to: 'switched', label: 'X' }];
    const run = new Run({ workflow: wf([model('model-1'), phase('a')]), engine: new FakeEngine(), switchModel: async (m, s) => { calls.push([m, s]); return outcomes.shift()!; } });
    await go(run);
    expect(run.status).toBe('paused');
    expect(run.pauseReason).toEqual({ type: 'stop', text: 'the switch question was closed before it was answered; Resume asks it again', stepId: 'model-1' });
    expect(run.snapshot().programCounter).toBe(0);
    run.resume();
    await go(run);
    expect(calls).toHaveLength(2);
    expect(run.status).toBe('done');
  });
});

describe('snapshot and restore', () => {
  it('keeps runCost, usdSpent, usdExtra and openSlice, and the restored run still switches', async () => {
    const run = new Run({ workflow: wf([model('model-1', { model: 'claude-x', usd: '0.10' }), phase('a'), phase('b'), phase('c')]), engine: new FakeEngine(costs(0.06, 0.06, 0.06)), switchModel: switched() });
    await go(run);
    run.allowUsd(0.05);
    const snap: RunSnapshot = JSON.parse(JSON.stringify(run.snapshot()));
    expect(snap.runCost).toBeCloseTo(0.12, 9);
    expect(snap.usdSpent).toEqual({ 'model-1': 0.12 });
    expect(snap.usdExtra).toEqual({ 'model-1': 0.07 });
    expect(snap.openSlice).toEqual({ step: 'model-1', usd: 0.1 });
    const back = Run.restore(snap, { engine: new FakeEngine(costs(0.01)) });
    const again = back.snapshot();
    expect([again.runCost, again.usdSpent, again.usdExtra, again.openSlice]).toEqual([snap.runCost, snap.usdSpent, snap.usdExtra, snap.openSlice]);

    const calls: Array<[string, string]> = [];
    const fresh = new Run({ workflow: wf([model('model-1'), phase('a')]), engine: new FakeEngine(), switchModel: switched() });
    const restored = Run.restore(fresh.snapshot(), { engine: new FakeEngine(), switchModel: switched(calls) });
    await go(restored);
    expect(calls).toEqual([['claude-x', 'model-1']]);
  });

  it('a snapshot from before C sums runCost from its engine_cost events', async () => {
    const run = new Run({ workflow: wf([phase('a'), phase('b')]), engine: new FakeEngine(costs(0.06, 0.06)) });
    await go(run);
    const snap = run.snapshot();
    delete snap.runCost;
    const back = Run.restore(snap, { engine: new FakeEngine() });
    expect(back.snapshot().runCost).toBeCloseTo(0.12, 9);
  });
});

describe('a restored run tells a fresh engine process what was already counted', () => {
  // A FakeEngine whose replies carry the provider's raw totals, and which keeps what open() received.
  const metered = (per: Array<Partial<TurnResult>>, opened: OpenOptions[]): Engine => {
    const base = new FakeEngine(costs(0.06, 0.06, 0.06));
    return {
      id: base.id,
      probe: () => base.probe(),
      open: async (o) => {
        opened.push(o);
        const s = await base.open(o);
        let i = 0;
        return { ...s, turn: async (t) => ({ ...(await s.turn(t)), ...(per[i++] ?? {}) }) };
      },
    };
  };
  const twoSteps = async (per: Array<Partial<TurnResult>>) => {
    const run = new Run({ workflow: wf([phase('a'), phase('b'), phase('c')]), engine: metered(per, []) });
    await run.step();
    await run.step();
    return run;
  };

  it('opens with the last raw total and per-model totals the run saw', async () => {
    const run = await twoSteps([{ total: 0.06, totals: { a: 0.06 } }, { total: 0.13, totals: { a: 0.08, b: 0.05 } }]);
    const snap: RunSnapshot = JSON.parse(JSON.stringify(run.snapshot()));
    expect(snap.lastTotal).toBe(0.13);
    expect(snap.lastTotals).toEqual({ a: 0.08, b: 0.05 });
    const opened: OpenOptions[] = [];
    const back = Run.restore(snap, { engine: metered([], opened) });
    await back.step();
    expect(opened).toHaveLength(1);
    expect(opened[0]!.costBase).toBe(0.13);
    expect(opened[0]!.costBaseByModel).toEqual({ a: 0.08, b: 0.05 });
  });

  it('a later reply with no total keeps the last total the run saw (it is not wiped)', async () => {
    const run = await twoSteps([{ total: 0.06, totals: { a: 0.06 } }, {}]);
    const snap: RunSnapshot = JSON.parse(JSON.stringify(run.snapshot()));
    expect(snap.lastTotal).toBe(0.06);
    expect(snap.lastTotals).toEqual({ a: 0.06 });
  });

  it('an old snapshot with neither field opens with neither key', async () => {
    const run = await twoSteps([{ total: 0.06, totals: { a: 0.06 } }, { total: 0.13 }]);
    const snap: RunSnapshot = JSON.parse(JSON.stringify(run.snapshot()));
    delete snap.lastTotal;
    delete snap.lastTotals;
    const opened: OpenOptions[] = [];
    await Run.restore(snap, { engine: metered([], opened) }).step();
    expect(opened).toHaveLength(1);
    expect('costBase' in opened[0]!).toBe(false);
    expect('costBaseByModel' in opened[0]!).toBe(false);
  });
});

describe('turn_ended carries the model of the reply', () => {
  it('names the usage event model when there is one, and has no model key otherwise', async () => {
    const engine = new FakeEngine([
      { text: 'REINS: done', events: [{ type: 'usage', model: 'm1', used: 10 }] },
      { text: 'REINS: done' },
    ]);
    const run = await go(new Run({ workflow: wf([phase('a'), phase('b')]), engine }));
    const ended = named(run, 'turn_ended');
    expect(ended[0]!.data.model).toBe('m1');
    expect('model' in ended[1]!.data).toBe(false);
  });
});
