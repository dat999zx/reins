// Milestone P, Task 29 phase D3 and D4 (a, f): spend that is not known is carried as UNKNOWN at run, slice and subagent level. A reply with no cost
// does not leave the full allowance to the next call, a subagent of unknown cost keeps its conversation, and the receipt marks what it leaves out.
import { describe, it, expect } from 'vitest';
import { Run, type SubagentOpen, type SubagentOpened } from '../src/run.js';
import { FakeEngine, type ScriptedTurn } from '../src/fake-engine.js';
import type { SwitchOutcome } from '../src/nodes/index.js';
import { receipt, USD_UNKNOWN, UNKNOWN_MARK, unpricedWords } from '../src/index.js';
import type { Step, Workflow } from '../src/model.js';

const step = (id: string, kind: Step['kind'], over: Partial<Step> = {}): Step => ({ id, kind, attrs: {}, cards: [], links: [], ...over });
const model = (id: string, attrs: Record<string, string>) => step(id, 'model', { attrs });
const subagent = (id: string, attrs: Record<string, string> = { model: 'm1' }) => step(id, 'subagent', { title: id, attrs, prompt: 'Look.' });
const wf = (steps: Step[], budget: Partial<Workflow['budget']> = { usd: 0.01 }): Workflow => ({
  version: 1, name: 't', budget: { turns: 50, minutes: 50, ...budget }, always: [], steps, autos: [],
});
const switched = async (m: string): Promise<SwitchOutcome> => ({ to: 'switched', label: m });
const go = async (run: Run) => { while (run.status === 'running') await run.step(); return run; };
const named = (run: Run, type: string) => run.getEvents().filter((e) => e.type === type);
/** A reply whose cost nobody knows: no `cost`, and the engine says so. */
const unknown = (text = 'ok', over: Partial<ScriptedTurn> = {}): ScriptedTurn => ({ text, unknownCost: true, ...over });

const rig = (workflow: Workflow, subScript: ScriptedTurn[]) => {
  const parent = new FakeEngine([]);
  const sub = new FakeEngine(subScript);
  const opens: SubagentOpen[] = [];
  const openSubagent = async (open: SubagentOpen): Promise<SubagentOpened> => {
    opens.push(open);
    const s = await sub.open({ policy: open.policy });
    return { session: s, model: open.model ?? 'm0', label: 'L' };
  };
  const run = new Run({ workflow, engine: parent, openSubagent, switchModel: switched });
  return { run, parent, sub, opens };
};

describe('D3: unknown spend poisons the allowance of the run', () => {
  it('two successive subagents under the workflow USD limit: the second is not opened once the first cost an unknown amount', async () => {
    const { run, sub, opens } = rig(wf([subagent('a'), subagent('b')]), [unknown('one'), { text: 'two', cost: 0.001 }]);
    await go(run);
    expect(sub.receivedTexts).toHaveLength(1);
    expect(opens).toHaveLength(1);
    expect(run.status).toBe('paused');
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', text: USD_UNKNOWN });
    expect(run.snapshot().runUnknown).toBe(true);
    expect(run.snapshot().subagents!['a']).toMatchObject({ unknown: true });
  });

  it('the same under a slice limit alone: the slice is unknown, a different slice is not', async () => {
    const steps = [model('m-a', { model: 'x', usd: '0.40' }), subagent('a'), subagent('b'), model('m-b', { model: 'y', usd: '0.40' }), subagent('c')];
    const { run, sub } = rig(wf(steps, {}), [unknown('one'), { text: 'two', cost: 0.001 }, { text: 'three', cost: 0.001 }]);
    await go(run);
    expect(sub.receivedTexts).toHaveLength(1);
    expect(run.pauseReason).toMatchObject({ type: 'usd-budget-used', stepId: 'm-a', text: USD_UNKNOWN });
    expect(run.snapshot().usdUnknown).toEqual(['m-a']);
    expect(run.snapshot().runUnknown).toBe(true);
  });

  it('no limit anywhere: an unknown cost stops nothing', async () => {
    const { run, sub } = rig(wf([subagent('a'), subagent('b')], {}), [unknown('one'), unknown('two')]);
    await go(run);
    expect(run.status).toBe('done');
    expect(sub.receivedTexts).toHaveLength(2);
  });

  it('a known cost is unchanged: the allowance is spent as before and nothing is flagged', async () => {
    const { run, sub } = rig(wf([subagent('a'), subagent('b')], { usd: 5 }), [{ text: 'one', cost: 0.001 }, { text: 'two', cost: 0.001 }]);
    await go(run);
    expect(run.status).toBe('done');
    expect(sub.receivedTexts).toHaveLength(2);
    expect(run.snapshot().runUnknown).toBeUndefined();
    expect(run.snapshot().usdUnknown).toBeUndefined();
  });

  it('the flags survive a snapshot and a restore', async () => {
    const { run } = rig(wf([subagent('a'), subagent('b')]), [unknown('one')]);
    await go(run);
    const again = Run.restore(JSON.parse(JSON.stringify(run.snapshot())), { engine: new FakeEngine([]) });
    expect(again.snapshot().runUnknown).toBe(true);
    expect(again.snapshot().subagents!['a']!.unknown).toBe(true);
  });

  it('a subagent of unknown cost keeps its conversation: Resume opens the same session, not a new one', async () => {
    const { run, opens } = rig(wf([subagent('a')], {}), [unknown('', { isError: true }), { text: 'done', cost: 0.001 }]);
    await go(run);
    expect(run.status).toBe('paused');
    const id = run.snapshot().subagents!['a']!.sessionId;
    run.resume();
    await go(run);
    expect(opens).toHaveLength(2);
    expect(opens[1]!.sessionId).toBe(id);
  });
});

describe('D4: the receipt and the figures say what is not known', () => {
  it('a call that failed with a spend nobody knows (the error carries it) counts as an unpriced reply and is on its subagent', async () => {
    const { run } = rig(wf([subagent('a')], {}), [{ text: '', reject: 'The reply ended before it was complete.', paid: { unknownCost: true } }]);
    await go(run);
    expect(named(run, 'engine_cost').map((e) => e.data)).toEqual([{ unknown: true, step: 'a' }]);
    const r = receipt(run.getEvents());
    expect(r.unpricedTurns).toBe(1);
    expect(r.subagents).toEqual([{ step: 'a', title: 'a', usd: 0, turns: 0, unknown: true }]);
    expect(run.snapshot().runUnknown).toBe(true);
  });

  it('a reply marked unknown shows on its model and its subagent, and the known ones next to it do not', () => {
    const at = (type: string, data: Record<string, unknown>) => ({ id: type, timestamp: 1, type: type as never, data });
    const r = receipt([
      at('run_started', { workflow: 'w' }),
      at('subagent_started', { step: 'a', title: 'A' }), at('subagent_started', { step: 'b', title: 'B' }),
      at('turn_ended', { step: 'a', model: 'm1', cost: 0.02 }),
      at('turn_ended', { step: 'a', model: 'm1', unknown: true }),
      at('turn_ended', { step: 'b', model: 'm2', cost: 0.01 }),
      at('engine_cost', { usd: 0.03, models: { m1: 0.02, m2: 0.01 } }),
    ]);
    expect(r.unpricedTurns).toBe(1);
    expect(r.models).toEqual([{ model: 'm1', usd: 0.02, turns: 2, unknown: true }, { model: 'm2', usd: 0.01, turns: 1 }]);
    expect(r.subagents).toEqual([{ step: 'a', title: 'A', usd: 0.02, turns: 2, unknown: true }, { step: 'b', title: 'B', usd: 0.01, turns: 1 }]);
  });

  it('the shared words', () => {
    expect(UNKNOWN_MARK).toBe(' + ?');
    expect(unpricedWords(1)).toBe('1 reply had no price; the total leaves it out');
    expect(unpricedWords(3)).toBe('3 replies had no price; the total leaves them out');
  });
});
