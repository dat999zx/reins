import { describe, it, expect } from 'vitest';
import type { LogRow } from '@reins/server/store.js';
import { contextWords, modelOptions, pickerBlock, tokens, usageOf } from '../src/usage.js';

let seq = 0;
const row = (type: string, data: unknown = {}): LogRow => ({ sessionId: 's1', seq: ++seq, ts: 1000 + seq, type, data });
const eng = (data: object) => row('engine', data);
const usage = (used: number, extra: object = {}) => eng({ type: 'usage', model: 'm1', used, window: 1_000_000, ...extra });

describe('tokens', () => {
  it('writes a count the way the header shows it', () => {
    expect(tokens(850)).toBe('850');
    expect(tokens(30_550)).toBe('31k');
    expect(tokens(523_112)).toBe('523k');
    expect(tokens(999_600)).toBe('1M');
    expect(tokens(1_000_000)).toBe('1M');
    expect(tokens(1_200_000)).toBe('1.2M');
  });
});

describe('usageOf', () => {
  it('is the newest usage row, fresh while nothing happened after it', () => {
    expect(usageOf([usage(10), usage(30_550)])).toEqual({ model: 'm1', used: 30_550, window: 1_000_000, stale: false });
  });
  it('is stale after a later engine row or a failed turn', () => {
    expect(usageOf([usage(10), eng({ type: 'text', text: 'x' })])?.stale).toBe(true);
    expect(usageOf([usage(10), row('turn_failed', { error: 'x' })])?.stale).toBe(true);
    expect(usageOf([usage(10), row('message', { text: 'x' })])?.stale).toBe(false);
  });
  it('is undefined with no usage row, and without a window key when none came', () => {
    expect(usageOf([row('message', { text: 'x' })])).toBeUndefined();
    const u = usageOf([eng({ type: 'usage', model: 'm1', used: 5 })])!;
    expect('window' in u).toBe(false);
  });
});

describe('contextWords', () => {
  it('reads fresh, unknown window, stale and none', () => {
    expect(contextWords({ model: 'm1', used: 30_550, window: 1_000_000, stale: false })).toEqual({
      text: 'Context 31k / 1M', title: 'm1: 30,550 of 1,000,000 tokens after the last reply.',
    });
    expect(contextWords({ model: 'm1', used: 30_550, stale: false }).text).toBe('Context 31k / ?');
    expect(contextWords({ model: 'm1', used: 30_550, window: 1_000_000, stale: true })).toEqual({
      text: 'Context ≥31k / 1M', title: 'At least this: measured before the latest activity.',
    });
    expect(contextWords(undefined)).toEqual({ text: 'Context —', title: 'Known after the next reply.' });
  });

  it('falls back to the catalog window only when the usage row has none; no usage stays unknown', () => {
    expect(contextWords({ model: 'm1', used: 30_550, stale: false }, 200_000).text).toBe('Context 31k / 200k');
    expect(contextWords({ model: 'm1', used: 30_550, window: 1_000_000, stale: false }, 200_000).text).toBe('Context 31k / 1M');
    expect(contextWords(undefined, 200_000).text).toBe('Context —');
  });
});

describe('modelOptions', () => {
  const list = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
  it('puts Default first, keeps the list order, and appends an off-list current id once', () => {
    expect(modelOptions(list)).toEqual([{ id: '', label: 'Default' }, ...list]);
    expect(modelOptions(list, 'b')).toEqual([{ id: '', label: 'Default' }, ...list]);
    expect(modelOptions(list, 'sonnet')).toEqual([{ id: '', label: 'Default' }, ...list, { id: 'sonnet', label: 'sonnet' }]);
  });
});

describe('pickerBlock', () => {
  it('says why the picker is off, or nothing', () => {
    expect(pickerBlock({ busy: true, detached: 0 })).toBe('Switch the model when the session is idle.');
    expect(pickerBlock({ busy: false, detached: 1 })).toBe('A run is left paused in this session. Resume or stop it before switching the model.');
    expect(pickerBlock({ busy: false, detached: 0 })).toBeUndefined();
  });
});
