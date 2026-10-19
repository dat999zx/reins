// Milestone P, Task 15 (spec 6.2): the receipt counts the replies that had no price; the total leaves them out.
import { describe, it, expect } from 'vitest';
import { receipt, Run, FakeEngine, parseWorkflow, type RunEventRecord } from '../src/index.js';

let n = 0;
const ev = (type: RunEventRecord['type'], data: Record<string, unknown> = {}): RunEventRecord => ({ id: `e${n++}`, timestamp: 1000 + n, type, data });

describe('receipt.unpricedTurns', () => {
  it('counts the turn_ended rows that ran on a model and have no cost; the total does not include them', () => {
    const r = receipt([
      ev('run_started', { workflow: 'w' }),
      ev('turn_ended', { step: 'a', model: 'm', cost: 0.01 }), ev('engine_cost', { usd: 0.01 }),
      ev('turn_ended', { step: 'b', model: 'm' }),
      ev('turn_ended', { step: 'c', model: 'm', cost: undefined }),
    ]);
    expect(r.unpricedTurns).toBe(2);
    expect(r.totalTurns).toBe(3);
    expect(r.totalCostUsd).toBe(0.01);
  });

  it('is absent when every reply was priced, and a cost of 0 is a price', () => {
    const r = receipt([ev('turn_ended', { model: 'm', cost: 0 }), ev('turn_ended', { model: 'm', cost: 0.02 })]);
    expect(r).not.toHaveProperty('unpricedTurns');
  });

  it('is absent for a run with no turns', () => {
    expect(receipt([ev('run_started', { workflow: 'w' })])).not.toHaveProperty('unpricedTurns');
  });

  it('a subagent step\'s unpriced reply counts too', () => {
    const r = receipt([
      ev('subagent_started', { step: 's', title: 'research' }),
      ev('turn_ended', { step: 's', model: 'm' }),
    ]);
    expect(r.unpricedTurns).toBe(1);
  });

  // A turn that names no model (a scripted one, an engine with no usage row) is not counted: the golden receipts of the earlier milestones hold such turns.
  it('a turn that names no model is not counted', () => {
    expect(receipt([ev('turn_ended', { step: 'a' })])).not.toHaveProperty('unpricedTurns');
  });

  it('through a Run: a reply on a model with no cost is counted, one with a cost is not', () => {
    const wf = parseWorkflow('---\nreins: 1\nname: t\nbudget: { turns: 9, minutes: 9 }\nalways: []\n---\n\n## phase a\n> a\n\n## phase b\n> b\n').workflow!;
    const usage = { type: 'usage' as const, model: 'm', used: 10 };
    const eng = new FakeEngine([{ text: 'REINS: done', cost: 0.01, events: [usage] }, { text: 'REINS: done', events: [usage] }]);
    const run = new Run({ workflow: wf, engine: eng });
    return (async () => {
      while (run.status === 'running') await run.step();
      const r = receipt(run.getEvents());
      expect(r.unpricedTurns).toBe(1);
      expect(r.totalTurns).toBe(2);
    })();
  });
});
