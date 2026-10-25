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

  it('says the dollars and turns per model after cost, and what was not split', () => {
    const models = [
      { model: 'a', label: 'Sonnet 5.5', usd: 0.13, turns: 4 },
      { model: 'b', label: 'Opus 5.5', usd: 0.16, turns: 2 },
    ];
    expect(receiptFields({ ...base, models }).slice(3)).toEqual([
      ['cost', '$0.5000'], ['models', 'Sonnet 5.5 $0.1300 (4 turns) · Opus 5.5 $0.1600 (2 turns)'],
    ]);
    expect(receiptFields({ ...base, models, unsplitUsd: 0.05 })[4]).toEqual(
      ['models', 'Sonnet 5.5 $0.1300 (4 turns) · Opus 5.5 $0.1600 (2 turns) · not split by model $0.0500']);
    expect(receiptFields({ ...base, models: [{ model: 'raw-id', usd: 0.007, turns: 1 }] })[4]).toEqual(['models', 'raw-id $0.0070 (1 turn)']);
  });

  it('adds every other field only when it is not zero', () => {
    const f = receiptFields({ ...base, gatesHeld: 1, guardRefusals: 2, totalRefusals: 2, verifyResults: { passed: 1, failed: 0 }, knowlRecalls: 4 });
    expect(f.slice(4)).toEqual([['gates held', '1'], ['refusals', '2'], ['guard refusals', '2'], ['verify passed', '1'], ['Knowl recalls', '4']]);
  });
});

describe('receiptFields: counts', () => {
  it('ends with one row per count a kind brought, and equals today\'s list without counts', () => {
    expect(receiptFields({ ...base, gatesHeld: 1, counts: { hops: 1 } }).slice(-2)).toEqual([['gates held', '1'], ['hops', '1']]);
    expect(receiptFields({ ...base, counts: { hops: 1 } })).toEqual([...receiptFields(base), ['hops', '1']]);
    expect(receiptFields({ ...base, counts: {} })).toEqual(receiptFields(base));
  });
});

describe('receiptFields: subagents', () => {
  it('says the dollars and turns per subagent after the models, and nothing without any', () => {
    const subagents = [{ step: 's', title: 'research', usd: 0.0640898, turns: 1 }, { step: 't', title: 'check', usd: 0.2, turns: 2 }];
    expect(receiptFields({ ...base, subagents })).toEqual([
      ['status', 'done'], ['turns', '3'], ['time', '12s'], ['cost', '$0.5000'], ['subagents', 'research $0.0641 (1 turn) · check $0.2000 (2 turns)'],
    ]);
    expect(receiptFields({ ...base, subagents: [] })).toEqual(receiptFields(base));
  });
});