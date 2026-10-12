import { describe, it, expect } from 'vitest';
import type { CatalogModel } from '../src/catalog.js';
import { contextSize, contextWindow, detachedRuns, priceFor, stillOverAfterCompaction, readSetting, switchEstimate, switchCheck } from '../src/settings.js';
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

describe('autoCompressAt and the compaction helpers (B)', () => {
  const compacted = () => row('engine', { type: 'compacted', trigger: 'manual', before: 30, after: 5 });

  it('autoCompressAt: 0.9 by default, a stored fraction up to 1 (off) is kept, anything else falls back', () => {
    const store = openStore(':memory:');
    expect(readSetting(store, 'autoCompressAt')).toBe(0.9);
    store.putSetting('autoCompressAt', 0.5);
    expect(readSetting(store, 'autoCompressAt')).toBe(0.5);
    store.putSetting('autoCompressAt', 1);
    expect(readSetting(store, 'autoCompressAt')).toBe(1);
    for (const bad of [0, 1.5, 'x']) {
      store.putSetting('autoCompressAt', bad);
      expect(readSetting(store, 'autoCompressAt')).toBe(0.9);
    }
    store.close();
  });

  it('a compaction makes the size unknown (the rule the deviation relies on)', () => {
    expect(contextSize([usage(30), compacted()])).toBeUndefined();
  });

  it('contextWindow is the newest usage row\'s window, whatever came after it', () => {
    expect(contextWindow([])).toBeUndefined();
    expect(contextWindow([row('engine', { type: 'usage', model: 'm', used: 5 })])).toBeUndefined();
    expect(contextWindow([usage(10), row('engine', { type: 'usage', model: 'm', used: 5, window: 200_000 })])).toBe(200_000);
    expect(contextWindow([usage(10), row('engine', { type: 'text', text: 'hi' }), compacted(), row('turn_failed', {})])).toBe(1_000_000);
  });

  it('contextWindow is unknown once the model was changed after the usage row', () => {
    const w = (n: number) => row('engine', { type: 'usage', model: 'm', used: 1, window: n });
    expect(contextWindow([w(200_000), row('settings', { model: 'x' })])).toBeUndefined();
    expect(contextWindow([row('settings', { model: 'x' }), w(1_000_000)])).toBe(1_000_000);
    expect(contextWindow([w(200_000), row('settings', { title: 't' })])).toBe(200_000);
  });

  it('stillOverAfterCompaction: a compaction, then usage rows that are all at or over the limit', () => {
    const f = (rows: LogRow[]) => stillOverAfterCompaction(rows, 10);
    expect(f([usage(20), compacted(), usage(10)])).toBe(true);
    expect(f([usage(20), compacted(), usage(10), usage(30), usage(11)])).toBe(true);
    expect(f([usage(20), compacted(), usage(10), usage(5)])).toBe(false);
    expect(f([usage(20), compacted(), usage(5), usage(30)])).toBe(false);
    expect(f([usage(20), compacted(), usage(5), compacted(), usage(30)])).toBe(true);
    expect(f([usage(20), compacted()])).toBe(false);
    expect(f([usage(20), usage(30)])).toBe(false);
    expect(f([])).toBe(false);
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

describe('switchCheck', () => {
  const base = { busy: false, detached: false, hasSession: true, used: 1000, target: 'm', label: 'Test model', estimate: 0.01, limits: { tokens: 200_000, usd: 0.5 } };
  const ask = (c: ReturnType<typeof switchCheck>) => (c && 'ask' in c ? c.ask : undefined);
  const SIZE = 'Asked because the context is at or over the 200,000-token switch limit.';
  it('busy and detached refuse with their words; busy beats detached', () => {
    expect(switchCheck({ ...base, busy: true })).toEqual({ refuse: 'Switch the model when the session is idle.' });
    expect(switchCheck({ ...base, detached: true })).toEqual({ refuse: 'A run is left paused in this session. Resume or stop it before switching the model.' });
    expect(switchCheck({ ...base, busy: true, detached: true })).toEqual({ refuse: 'Switch the model when the session is idle.' });
  });
  it('the other four ask, with the card words', () => {
    expect(switchCheck({ ...base, used: undefined })).toEqual({ ask: {
      prompt: 'Switch to Test model?',
      detail: 'The whole conversation goes to Test model as input. Reins does not know its size, so the cost cannot be estimated.',
    } });
    expect(ask(switchCheck({ ...base, used: 523_112, label: 'Opus 5.5', estimate: 4.184896 }))?.detail).toBe(
      `The whole conversation, 523,112 tokens, goes to Opus 5.5 as input. Estimate: about $4.18 (an estimate from the provider's price table).\n${SIZE}`);
    expect(ask(switchCheck({ ...base, used: 37_000, label: 'Fable 5.1', estimate: 0.7 }))?.detail).toBe(
      "The whole conversation, 37,000 tokens, goes to Fable 5.1 as input. Estimate: about $0.70 (an estimate from the provider's price table).\nAsked because the estimate is at or over the $0.50 switch limit.");
    expect(ask(switchCheck({ ...base, label: 'Fable 5.1', estimate: undefined }))?.detail).toBe(
      'The whole conversation, 1,000 tokens, goes to Fable 5.1 as input. No price is known for Fable 5.1, so the cost cannot be estimated.');
    expect(ask(switchCheck({ ...base, used: 523_112, estimate: undefined, label: 'Fable 5.1' }))?.detail).toBe(
      `The whole conversation, 523,112 tokens, goes to Fable 5.1 as input. No price is known for Fable 5.1, so the cost cannot be estimated.\n${SIZE}`);
  });
  it('both limits are "at or over": exactly the limit asks, one step under does not', () => {
    expect(ask(switchCheck({ ...base, used: 200_000 }))?.detail).toContain(SIZE);
    expect(switchCheck({ ...base, used: 199_999 })).toBeUndefined();
    expect(ask(switchCheck({ ...base, estimate: 0.5 }))?.detail).toContain('Asked because the estimate is at or over the $0.50 switch limit.');
    expect(switchCheck({ ...base, estimate: 0.49 })).toBeUndefined();
  });
  it('no session asks nothing whatever the size; under both limits is fine', () => {
    expect(switchCheck({ ...base, hasSession: false, used: undefined, estimate: undefined })).toBeUndefined();
    expect(switchCheck({ ...base, hasSession: false, used: 900_000, estimate: 9 })).toBeUndefined();
    expect(switchCheck(base)).toBeUndefined();
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

describe('switchCheck source', () => {
  const o = { busy: false, detached: false, hasSession: true, used: 37_000, target: 'm', label: 'Fable 5.1', estimate: 0.7, limits: { tokens: 200_000, usd: 0.5 } };
  const detail = (c: ReturnType<typeof switchCheck>) => (c && 'ask' in c ? c.ask.detail : '');
  it('words the estimate by where its price came from', () => {
    expect(detail(switchCheck({ ...o, source: 'table' }))).toContain("(an estimate from the provider's price table)");
    expect(detail(switchCheck({ ...o, source: 'catalog' }))).toContain('(an estimate from catalog prices, 1-hour cache write)');
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