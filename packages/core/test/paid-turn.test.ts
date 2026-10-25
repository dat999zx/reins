// Milestone P, Task 29 phase B3: a turn that rejects can still have spent money (an engine's paid compaction before the reply that failed).
// The error carries it as `paid`, and the Run counts it as spend of the step: the room, the slice and the receipt include it.
import { describe, it, expect } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { FakeEngine, type EngineSession, type OpenOptions } from '../src/fake-engine.js';
import { receipt } from '../src/receipt.js';
import { Run } from '../src/run.js';
import type { Workflow } from '../src/model.js';

const wf = (body: string, usd = 0.1): Workflow => {
  const r = parseWorkflow(`---\nreins: 1\nname: t\nbudget: { turns: 40, minutes: 60, usd: ${usd} }\nalways: []\n---\n\n${body}\n`);
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return r.workflow!;
};

/** An engine whose turns reject with `err`. */
class Failing extends FakeEngine {
  constructor(private readonly err: Error) { super([]); }
  override async open(o: OpenOptions): Promise<EngineSession> {
    const s = await super.open(o);
    return { sessionId: s.sessionId, turn: async () => { throw this.err; }, interrupt: () => s.interrupt(), events: s.events, close: () => s.close() };
  }
}

describe('a turn that rejects with `paid`', () => {
  it('counts as spend of the run: the room, the engine_cost event and the receipt', async () => {
    const err = Object.assign(new Error('the reply failed'), { paid: { cost: 0.02, total: 0.7, models: { m: 0.02 } } });
    const run = new Run({ workflow: wf('## phase a\n> a'), engine: new Failing(err) });
    await run.step().catch(() => {});
    expect(run.usdRoom()).toBeCloseTo(0.08, 12);
    const costs = run.getEvents().filter((e) => e.type === 'engine_cost');
    expect(costs.map((e) => e.data)).toEqual([{ usd: 0.02, models: { m: 0.02 } }]);
    expect(receipt(run.getEvents()).totalCostUsd).toBeCloseTo(0.02, 12);
    expect(run.getEvents().filter((e) => e.type === 'turn_ended')).toEqual([]); // no turn was answered
  });

  it('counts against the open slice as well', async () => {
    const err = Object.assign(new Error('the reply failed'), { paid: { cost: 0.03 } });
    const body = '## model\nmodel: m\nusd: 0.05\n\n## phase a\n> a';
    const run = new Run({ workflow: wf(body, 5), engine: new Failing(err), switchModel: async () => ({ to: 'switched', label: 'm' }) });
    await run.step();
    await run.step().catch(() => {});
    expect(run.usdRoom()).toBeCloseTo(0.02, 12);
  });

  it('an error with no `paid`, or a paid that is not a positive number, counts nothing', async () => {
    for (const err of [new Error('plain'), Object.assign(new Error('x'), { paid: { cost: -1 } }), Object.assign(new Error('x'), { paid: { cost: Number.NaN } }), Object.assign(new Error('x'), { paid: 'lots' })]) {
      const run = new Run({ workflow: wf('## phase a\n> a'), engine: new Failing(err) });
      await run.step().catch(() => {});
      expect(run.usdRoom()).toBe(0.1);
      expect(run.getEvents().filter((e) => e.type === 'engine_cost')).toEqual([]);
    }
  });
});
