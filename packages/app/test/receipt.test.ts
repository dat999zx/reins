import { describe, it, expect } from 'vitest';
import type { Receipt } from '@reins/core';
import { receiptFields } from '../src/rows/receipt.js';

const base: Receipt = {
  workflow: 'w', status: 'done', totalTurns: 3, totalTimeMs: 12_400, totalCostUsd: 0.5, gatesHeld: 0, guardRefusals: 0, readOnlyRefusals: 0,
  totalRefusals: 0, loopAttempts: 0, autoCardsFired: 0, liveCardsDelivered: 0, verifyResults: { passed: 0, failed: 0 },
  knowlRecalls: 0, knowlStores: 0, knowlSkipped: 0,
};

describe('receiptFields', () => {
  it('always shows status, turns, time and cost, and nothing else when the rest is zero', () => {
    expect(receiptFields(base)).toEqual([['status', 'done'], ['turns', '3'], ['time', '12s'], ['cost', '$0.5000']]);
  });

  it('adds every other field only when it is not zero', () => {
    const f = receiptFields({ ...base, gatesHeld: 1, guardRefusals: 2, totalRefusals: 2, verifyResults: { passed: 1, failed: 0 }, knowlRecalls: 4 });
    expect(f.slice(4)).toEqual([['gates held', '1'], ['refusals', '2'], ['guard refusals', '2'], ['verify passed', '1'], ['Knowl recalls', '4']]);
  });
});
