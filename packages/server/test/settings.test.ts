import { describe, it, expect } from 'vitest';
import type { CatalogModel } from '../src/catalog.js';
import { contextSize, detachedRuns, priceFor, readSetting, switchEstimate, switchRefusal } from '../src/settings.js';
import { openStore, type LogRow } from '../src/store.js';

let seq = 0;
const row = (type: string, data: unknown = null, runId?: string): LogRow =>
  ({ sessionId: 's', seq: ++seq, ts: 0, type, data, ...(runId ? { runId } : {}) });
const usage = (used: number) => row('engine', { type: 'usage', model: 'm', used, window: 1_000_000 });

describe('readSetting', () => {
  it('reads the default, a stored value, and falls back on an invalid one', () => {
    const store = openStore(':memory:');
    expect(readSetting(store, 'switchApprovalTokens')).toBe(200_000);
    expect(readSetting(store, 'switchApprovalUsd')).toBe(0.5);
    store.putSetting('switchApprovalTokens', 5000);
    store.putSetting('switchApprovalUsd', 1.25);
    expect(readSetting(store, 'switchApprovalTokens')).toBe(5000);
    expect(readSetting(store, 'switchApprovalUsd')).toBe(1.25);
    store.putSetting('switchApprovalTokens', -1);
    store.putSetting('switchApprovalUsd', 'x');
    expect(readSetting(store, 'switchApprovalTokens')).toBe(200_000);
    expect(readSetting(store, 'switchApprovalUsd')).toBe(0.5);
    store.close();
  });
});

describe('contextSize', () => {
  it('is the newest usage, and unknown once anything else happened after it', () => {
    expect(contextSize([])).toBeUndefined();
    expect(contextSize([usage(10), usage(30)])).toBe(30);
    expect(contextSize([usage(30), row('note', { text: 'x' })])).toBe(30);
    expect(contextSize([usage(30), row('engine', { type: 'text', text: 'hi' })])).toBeUndefined();
    expect(contextSize([usage(30), row('engine', { type: 'tool_call', tool: 'Read', input: {} })])).toBeUndefined();
    expect(contextSize([usage(30), row('engine', { type: 'error', message: 'x' })])).toBeUndefined();
    expect(contextSize([usage(30), row('turn_failed', { error: 'x' })])).toBeUndefined();
    expect(contextSize([usage(10), row('engine', { type: 'text', text: 'hi' }), usage(5)])).toBe(5);
    expect(contextSize([usage(10), row('turn_failed', { error: 'x' }), row('engine', { type: 'text', text: 'hi' })])).toBeUndefined();
  });
});

describe('detachedRuns', () => {
  it('lists runs whose last row is run_detached', () => {
    expect(detachedRuns([row('run_started', {}, 'r1'), row('run_detached', {}, 'r1')])).toEqual(['r1']);
    expect(detachedRuns([row('run_detached', {}, 'r1'), row('note', {}, 'r1')])).toEqual([]);
    expect(detachedRuns([row('run_detached', {}, 'r1'), row('run_detached', {}, 'r2'), row('run_finished', {}, 'r1')])).toEqual(['r2']);
  });
});

describe('switchEstimate', () => {
  it('is tokens times the cache-write price, else the input price, per million', () => {
    expect(switchEstimate(37_000, { input: 5, cacheWrite: 10 })).toBeCloseTo(0.37, 10);
    expect(switchEstimate(1_000_000, { input: 5 })).toBe(5);
    expect(switchEstimate(37_000)).toBeUndefined();
  });
});

describe('switchRefusal', () => {
  const base = { busy: false, detached: false, hasSession: true, used: 1000, target: 'm', label: 'Test model', estimate: 0.01, limits: { tokens: 200_000, usd: 0.5 } };
  it('says each of the six sentences, in order', () => {
    expect(switchRefusal({ ...base, busy: true })).toBe('Switch the model when the session is idle.');
    expect(switchRefusal({ ...base, detached: true })).toBe('A run is left paused in this session. Resume or stop it before switching the model.');
    expect(switchRefusal({ ...base, used: undefined })).toBe('Reins does not know the current context size. Send one message, then switch.');
    expect(switchRefusal({ ...base, used: 523_112 })).toBe(
      'The context is 523,112 tokens, at or over the 200,000-token switch limit. Switching needs your approval, which Reins cannot ask for yet.');
    expect(switchRefusal({ ...base, used: 37_000, label: 'Fable 5.1', estimate: 0.7 })).toBe(
      'Switching sends 37,000 tokens to Fable 5.1: about $0.70 (an estimate from the provider\'s price table), at or over the $0.50 switch limit. Switching needs your approval, which Reins cannot ask for yet.');
    expect(switchRefusal({ ...base, label: 'Fable 5.1', estimate: undefined })).toBe(
      'No price is known for Fable 5.1, so the switch cannot be estimated. Switching needs your approval, which Reins cannot ask for yet.');
  });
  it('both limits are "at or over": exactly the limit refuses, one step under does not', () => {
    expect(switchRefusal({ ...base, used: 200_000 })).toContain('at or over the 200,000-token switch limit');
    expect(switchRefusal({ ...base, used: 199_999 })).toBeUndefined();
    expect(switchRefusal({ ...base, estimate: 0.5 })).toContain('at or over the $0.50 switch limit');
    expect(switchRefusal({ ...base, estimate: 0.49 })).toBeUndefined();
  });
  it('busy beats detached; no session asks nothing; under both limits is fine', () => {
    expect(switchRefusal({ ...base, busy: true, detached: true })).toBe('Switch the model when the session is idle.');
    expect(switchRefusal({ ...base, hasSession: false, used: undefined, estimate: undefined })).toBeUndefined();
    expect(switchRefusal({ ...base, hasSession: false, used: 900_000, estimate: 9 })).toBeUndefined();
    expect(switchRefusal(base)).toBeUndefined();
  });
});

describe('priceFor', () => {
  const provider = { prices: { t: { input: 2, cacheWrite: 4 } }, cacheWritePerInput: 2 };
  const cat = (price?: CatalogModel['price']): CatalogModel[] => [{ id: 'c', label: 'C', ...(price ? { price } : {}) }];
  it('the provider table comes first and is labelled table', () => {
    expect(priceFor(provider, cat({ input: 9, output: 9 }), 't', 1000)).toEqual({ input: 2, cacheWrite: 4, source: 'table' });
  });
  it('else the catalog input times cacheWritePerInput, labelled catalog', () => {
    expect(priceFor(provider, cat({ input: 3, output: 9, cacheWrite: 3.75 }), 'c', 1000)).toEqual({ input: 3, cacheWrite: 6, source: 'catalog' });
  });
  it('a context tier at or under the tokens is used; its missing input refuses', () => {
    const tiered = cat({ input: 1, output: 9, tiers: [{ size: 100, input: 5 }, { size: 500 }] });
    expect(priceFor(provider, tiered, 'c', 99)).toEqual({ input: 1, cacheWrite: 2, source: 'catalog' });
    expect(priceFor(provider, tiered, 'c', 100)).toEqual({ input: 5, cacheWrite: 10, source: 'catalog' });
    expect(priceFor(provider, tiered, 'c', 500)).toBeUndefined();
  });
  it('is undefined with no table row and no catalog price, or no cacheWritePerInput', () => {
    expect(priceFor(provider, [], 'c', 1)).toBeUndefined();
    expect(priceFor(provider, cat(), 'c', 1)).toBeUndefined();
    expect(priceFor({ prices: {} }, cat({ input: 3, output: 9 }), 'c', 1)).toBeUndefined();
  });
});

describe('switchRefusal source', () => {
  const o = { busy: false, detached: false, hasSession: true, used: 37_000, target: 'm', label: 'Fable 5.1', estimate: 0.7, limits: { tokens: 200_000, usd: 0.5 } };
  it('words the estimate by where its price came from', () => {
    expect(switchRefusal({ ...o, source: 'table' })).toContain("(an estimate from the provider's price table)");
    expect(switchRefusal({ ...o, source: 'catalog' })).toContain('(an estimate from catalog prices, 1-hour cache write)');
  });
});

describe('pickerLimit', () => {
  it('defaults to 8 and falls back on an invalid value', () => {
    const store = openStore(':memory:');
    expect(readSetting(store, 'pickerLimit')).toBe(8);
    store.putSetting('pickerLimit', 3);
    expect(readSetting(store, 'pickerLimit')).toBe(3);
    store.putSetting('pickerLimit', 0);
    expect(readSetting(store, 'pickerLimit')).toBe(8);
    store.close();
  });
});