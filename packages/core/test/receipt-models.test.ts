// The receipt's per-model dollars and turns (milestone C, Task 4b): sums are checked against the total.
import { describe, it, expect } from 'vitest';
import { receipt, type RunEventRecord } from '../src/index.js';

let n = 0;
const ev = (type: RunEventRecord['type'], data: Record<string, unknown> = {}): RunEventRecord => ({ id: `e${n++}`, timestamp: 1000 + n, type, data });

describe('receipt models', () => {
  it('turns count per model from turn_ended.model, dollars from engine_cost.models, and the rest is unsplitUsd', () => {
    const r = receipt([
      ev('run_started', { workflow: 'w' }),
      ev('turn_ended', { model: 'a' }), ev('engine_cost', { usd: 0.1, models: { a: 0.1 } }),
      ev('turn_ended', { model: 'a' }), ev('engine_cost', { usd: 0.2, models: { b: 0.2 } }),
      ev('turn_ended', { model: 'b' }), ev('engine_cost', { usd: 0.05 }),
    ]);
    // the 0.2 above is a's second turn's dollars landing on b: the model of a turn and the model of its dollars are separate facts
    expect(r.models).toEqual([{ model: 'a', usd: 0.1, turns: 2 }, { model: 'b', usd: 0.2, turns: 1 }]);
    expect(r.unsplitUsd).toBeCloseTo(0.05, 9);
    expect(r.totalCostUsd).toBe(0.35);
    const parts = r.models!.reduce((a, m) => a + m.usd, 0) + r.unsplitUsd!;
    expect(parts).toBeCloseTo(r.totalCostUsd, 9);
  });

  it('a fully split run has no unsplitUsd and the models sum to the total', () => {
    const r = receipt([
      ev('turn_ended', { model: 'a' }), ev('engine_cost', { usd: 0.03, models: { a: 0.01, b: 0.02 } }),
      ev('turn_ended', { model: 'b' }), ev('engine_cost', { usd: 0.04, models: { b: 0.04 } }),
    ]);
    expect(r.models).toEqual([{ model: 'a', usd: 0.01, turns: 1 }, { model: 'b', usd: 0.06, turns: 1 }]);
    expect(r).not.toHaveProperty('unsplitUsd');
    expect(r.models!.reduce((a, m) => a + m.usd, 0)).toBeCloseTo(r.totalCostUsd, 9);
  });

  it('per-model dollars are rounded to 6 decimals, so float sums print clean (0.1 + 0.2 is 0.3)', () => {
    const r = receipt([
      ev('turn_ended', { model: 'a' }), ev('engine_cost', { usd: 0.1, models: { a: 0.1 } }),
      ev('turn_ended', { model: 'a' }), ev('engine_cost', { usd: 0.2, models: { a: 0.2 } }),
    ]);
    expect(r.models).toEqual([{ model: 'a', usd: 0.3, turns: 2 }]);
  });

  it('a model with turns and no dollars still shows, with 0', () => {
    const r = receipt([ev('turn_ended', { model: 'a' }), ev('engine_cost', { usd: 0.02 })]);
    expect(r.models).toEqual([{ model: 'a', usd: 0, turns: 1 }]);
    expect(r.unsplitUsd).toBeCloseTo(0.02, 9);
  });

  it('no model data: no models key and no unsplitUsd (old receipts are unchanged)', () => {
    const r = receipt([ev('turn_ended', {}), ev('engine_cost', { usd: 0.02 })]);
    expect(r).not.toHaveProperty('models');
    expect(r).not.toHaveProperty('unsplitUsd');
    expect(r.totalCostUsd).toBe(0.02);
  });

  it('a subagent shows its dollars and turns; its model and the parent\'s sum to the total; none, no key', () => {
    const r = receipt([
      ev('run_started', { workflow: 'w' }),
      ev('subagent_started', { step: 's', title: 'research' }),
      ev('turn_ended', { step: 's', cost: 0.06, model: 'h' }), ev('engine_cost', { usd: 0.06, models: { h: 0.06 } }),
      ev('turn_ended', { step: 'p', cost: 0.1, model: 'o' }), ev('engine_cost', { usd: 0.1, models: { o: 0.1 } }),
    ]);
    expect(r.subagents).toEqual([{ step: 's', title: 'research', usd: 0.06, turns: 1 }]);
    expect(r.models).toEqual([{ model: 'h', usd: 0.06, turns: 1 }, { model: 'o', usd: 0.1, turns: 1 }]);
    expect(r.totalCostUsd).toBe(0.16);
    expect(r.models!.reduce((a, m) => a + m.usd, 0)).toBeCloseTo(r.totalCostUsd, 9);
    expect(r).not.toHaveProperty('unsplitUsd');
    expect(r.totalTurns).toBe(2);

    expect(receipt([ev('turn_ended', { step: 'p', cost: 0.1 })])).not.toHaveProperty('subagents');
  });

  it('a subagent that resumed counts every reply on the one entry, and a started row twice adds no second entry', () => {
    const r = receipt([
      ev('subagent_started', { step: 's', title: 'research' }), ev('turn_ended', { step: 's', cost: 0.01 }),
      ev('subagent_started', { step: 's', title: 'research', resumed: true }), ev('turn_ended', { step: 's', cost: 0.02 }),
    ]);
    expect(r.subagents).toEqual([{ step: 's', title: 'research', usd: 0.03, turns: 2 }]);
  });

  it('an unsplit total under 0.00005 is not reported (float dust)', () => {
    const r = receipt([ev('turn_ended', { model: 'a' }), ev('engine_cost', { usd: 0.1 + 0.2, models: { a: 0.3 } })]);
    expect(r).not.toHaveProperty('unsplitUsd');
    expect(r.models).toEqual([{ model: 'a', usd: 0.3, turns: 1 }]);
  });
});

describe('receipt: subagents, edges', () => {
  it('a subagent_started row with no title falls back to the step id, and the dollars are rounded to 6 places', () => {
    const r = receipt([
      ev('subagent_started', { step: 's' }),
      ev('turn_ended', { step: 's', cost: 0.1 }), ev('turn_ended', { step: 's', cost: 0.2 }),
    ]);
    expect(r.subagents).toEqual([{ step: 's', title: 's', usd: 0.3, turns: 2 }]);
  });
});
