import { describe, it, expect } from 'vitest';
import type { LogRow } from '@reins/server/store.js';
import { compressBlock, compressBusy, contextWords, hasReplied, modelOptions, pickerBlock, tokens, usageOf } from '../src/usage.js';

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
  it('after a compaction is its figure as a lower bound, with the model and window of the usage before it', () => {
    const c = (data: object = {}) => eng({ type: 'compacted', trigger: 'manual', before: 33_781, after: 3_873, ...data });
    expect(usageOf([usage(30_550), c()])).toEqual({ model: 'm1', used: 3_873, window: 1_000_000, stale: true, compressed: true });
    expect(usageOf([usage(30_550), c(), row('turn_failed', { error: 'x' })])?.compressed).toBe(true);
    expect(usageOf([usage(30_550), c(), usage(37_000)])).toEqual({ model: 'm1', used: 37_000, window: 1_000_000, stale: false });
    expect(usageOf([usage(30_550), { ...c(), data: { type: 'compacted', trigger: 'manual', before: 33_781 } }])).toBeUndefined();
    expect(usageOf([c()])).toBeUndefined();
  });
  it('ignores a figure that is not a whole non-negative count, and the newest compaction wins over an older one', () => {
    const c = (data: object = {}) => eng({ type: 'compacted', trigger: 'manual', before: 33_781, after: 3_873, ...data });
    expect(usageOf([usage(30_550), c({ after: 3_873.5 })])).toBeUndefined();
    expect(usageOf([usage(30_550), c({ after: -1 })])).toBeUndefined();
    expect(usageOf([usage(30_550), c({ after: 3_873 }), c({ after: 900 })])?.used).toBe(900);
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

  it('reads a figure after compressing as a lower bound the next reply measures again', () => {
    expect(contextWords({ model: 'm1', used: 3_873, window: 1_000_000, stale: true, compressed: true })).toEqual({
      text: 'Context ≥4k / 1M', title: "At least this: the provider's figure after compressing. The next reply measures it again.",
    });
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

describe('compressBlock', () => {
  it('says why Compress is off, or nothing', () => {
    expect(compressBlock({ busy: true, replied: true })).toBe('Compress when the session is idle.');
    expect(compressBlock({ busy: false, replied: false })).toBe('Nothing to compress before the first reply.');
    expect(compressBlock({ busy: true, replied: false })).toBe('Compress when the session is idle.');
    expect(compressBlock({ busy: false, replied: true })).toBeUndefined();
  });
});

describe('compressBusy', () => {
  it('a waiting switch card alone is not work; running, or waiting on anything else, is', () => {
    expect(compressBusy('running', [])).toBe(true);
    expect(compressBusy('running', ['switch'])).toBe(true);
    expect(compressBusy('waiting', ['switch'])).toBe(false);
    expect(compressBusy('waiting', ['switch', 'tool'])).toBe(true);
    expect(compressBusy('waiting', [])).toBe(true);
    expect(compressBusy('idle', [])).toBe(false);
  });
});

describe('hasReplied', () => {
  const ended = () => row('turn_ended', { text: 'ok' });
  const err = () => eng({ type: 'error', message: 'x' });
  it('is true after a reply without an error event; a first turn that ended in an error, or failed, has no id to compress', () => {
    expect(hasReplied([])).toBe(false);
    expect(hasReplied([ended()])).toBe(true);
    expect(hasReplied([err(), ended()])).toBe(false);
    expect(hasReplied([row('turn_failed', { error: 'x' })])).toBe(false);
    expect(hasReplied([err(), ended(), ended()])).toBe(true);
    expect(hasReplied([ended(), err(), ended()])).toBe(true);
    // a failed turn ends the error's turn: the error before it does not follow into the next reply
    expect(hasReplied([err(), row('turn_failed', { error: 'x' }), ended()])).toBe(true);
  });
});

describe('pickerBlock', () => {
  it('says why the picker is off, or nothing', () => {
    expect(pickerBlock({ busy: true, detached: 0 })).toBe('Switch the model when the session is idle.');
    expect(pickerBlock({ busy: false, detached: 1 })).toBe('A run is left paused in this session. Resume or stop it before switching the model.');
    expect(pickerBlock({ busy: false, detached: 0 })).toBeUndefined();
    expect(pickerBlock({ busy: true, detached: 1, asking: true })).toBe('Answer the switch question first.');
  });
});
