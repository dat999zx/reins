// Milestone P, Task 29 phase D4 (d, e): the app does not show a known-looking figure where a cost is not known. The mark is written once (unknown.ts)
// and held equal to core's, which the terminal uses.
import { describe, it, expect } from 'vitest';
import { UNKNOWN_MARK as CORE_MARK, type Receipt } from '@reins/core';
import type { LogRow } from '@reins/server/store.js';
import { receiptFields } from '../src/rows/receipt.js';
import { initial, reduceAll } from '../src/state.js';
import { meter, runView } from '../src/runState.js';
import { dollars, UNKNOWN_MARK } from '../src/unknown.js';

const base: Receipt = {
  workflow: 'w', status: 'done', totalTurns: 3, totalTimeMs: 12_400, totalCostUsd: 0.5, gatesHeld: 0, guardRefusals: 0, readOnlyRefusals: 0,
  totalRefusals: 0, loopAttempts: 0, autoCardsFired: 0, liveCardsDelivered: 0, verifyResults: { passed: 0, failed: 0 },
  knowlRecalls: 0, knowlStores: 0, knowlSkipped: 0,
};
let seq = 0;
const row = (type: string, data?: unknown, runId = ''): LogRow => ({ sessionId: 's1', seq: ++seq, ts: 1000 * seq, type, data, ...(runId ? { runId } : {}) });
const sess = (rows: LogRow[]) => reduceAll(initial(), rows, 0).sessions.s1!;

describe('the one mark', () => {
  it('is core\'s', () => {
    expect(UNKNOWN_MARK).toBe(CORE_MARK);
    expect(dollars(0.02, 4)).toBe('$0.0200');
    expect(dollars(0.02, 4, true)).toBe('$0.0200 + ?');
  });
});

describe('D4 (d): the receipt row', () => {
  it('shows unpriced replies on the cost, and the unknown part of a model and a subagent', () => {
    const f = receiptFields({
      ...base, unpricedTurns: 2,
      models: [{ model: 'a', usd: 0.2, turns: 2, unknown: true }, { model: 'b', usd: 0.3, turns: 1 }],
      subagents: [{ step: 's', title: 'Scout', usd: 0, turns: 1, unknown: true }],
    });
    expect(f.find(([k]) => k === 'cost')![1]).toBe('$0.5000 + ?');
    expect(f.find(([k]) => k === 'unpriced replies')![1]).toContain('2');
    expect(f.find(([k]) => k === 'models')![1]).toBe('a $0.2000 + ? (2 turns) · b $0.3000 (1 turn)');
    expect(f.find(([k]) => k === 'subagents')![1]).toBe('Scout $0.0000 + ? (1 turn)');
  });

  it('a fully priced receipt is as it was', () => {
    expect(receiptFields(base)).toEqual([['status', 'done'], ['turns', '3'], ['time', '12s'], ['cost', '$0.5000']]);
  });
});

describe('D4 (e): the session total', () => {
  it('a turn with no cost marks the total "at least"; a priced one does not', () => {
    seq = 0;
    expect(sess([row('turn_ended', { text: 'a', cost: 0.01 })])).toMatchObject({ cost: 0.01 });
    expect(sess([row('turn_ended', { text: 'a', cost: 0.01 })]).costUnknown).toBeUndefined();
    seq = 0;
    const s = sess([row('turn_ended', { text: 'a', cost: 0.01 }), row('turn_ended', { text: 'b' })]);
    expect(s.cost).toBeCloseTo(0.01, 12);
    expect(s.costUnknown).toBe(true);
  });

  it('a turn marked unknown, and a failed call\'s note, mark it too', () => {
    seq = 0;
    expect(sess([row('turn_ended', { text: 'a', cost: 0.02, unknown: true })]).costUnknown).toBe(true);
    seq = 0;
    expect(sess([row('engine_cost', { unknown: true, step: 'x' }, 'r1')]).costUnknown).toBe(true);
  });
});

describe('D4 (e): the run total and its meter', () => {
  const start = () => row('run_started', { workflow: 'wf', steps: [{ id: 'plan', kind: 'phase' }] }, 'r1');
  it('a run turn with no cost marks the run total and the USD meter', () => {
    seq = 0;
    const v = runView(sess([start(), row('turn_ended', { step: 'plan', text: '', cost: 0.01 }, 'r1'), row('turn_ended', { step: 'plan', text: '' }, 'r1')]));
    expect(v.cost).toBeCloseTo(0.01, 12);
    expect(v.costUnknown).toBe(true);
    const usd = meter(v, { turns: 10, minutes: 10, usd: 1 }, 0).find((m) => m.key === 'usd')!;
    expect(usd.text.startsWith('$0.01 + ? / $1.00')).toBe(true);
  });

  it('a run of priced turns shows an exact meter', () => {
    seq = 0;
    const v = runView(sess([start(), row('turn_ended', { step: 'plan', text: '', cost: 0.01 }, 'r1')]));
    expect(v.costUnknown).toBeUndefined();
    expect(meter(v, { turns: 10, minutes: 10, usd: 1 }, 0).find((m) => m.key === 'usd')!.text).toBe('$0.01 / $1.00');
  });
});
