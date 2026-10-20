import { describe, it, expect } from 'vitest';
import type { LogRow } from '@reins/server/store.js';
import { compressBlock, compressBusy, contextWords, effortBlock, groupOptions, hasReplied, modelGroups, modelOptions, pickerBlock, shownEffort, shownModel, tokens, typedModel, usableProvider, usageOf, windowOf } from '../src/usage.js';

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
    expect(contextWords(undefined)).toEqual({ text: 'Context 0 / ?', title: 'Measured after the first reply.' });
  });

  it('reads a figure after compressing as a lower bound the next reply measures again', () => {
    expect(contextWords({ model: 'm1', used: 3_873, window: 1_000_000, stale: true, compressed: true })).toEqual({
      text: 'Context ≥4k / 1M', title: "At least this: the provider's figure after compressing. The next reply measures it again.",
    });
  });

  it('falls back to the catalog window only when the usage row has none; no usage reads 0 of the catalog window', () => {
    expect(contextWords({ model: 'm1', used: 30_550, stale: false }, 200_000).text).toBe('Context 31k / 200k');
    expect(contextWords({ model: 'm1', used: 30_550, window: 1_000_000, stale: false }, 200_000).text).toBe('Context 31k / 1M');
    expect(contextWords(undefined, 200_000).text).toBe('Context 0 / 200k');
  });
});

describe('modelOptions', () => {
  const list = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
  it('keeps the list order and appends an off-list current id once', () => {
    expect(modelOptions(list)).toEqual(list);
    expect(modelOptions(list, 'b')).toEqual(list);
    expect(modelOptions(list, 'sonnet')).toEqual([...list, { id: 'sonnet', label: 'sonnet' }]);
  });
});

describe('providers in one picker', () => {
  const providers = [
    { id: 'alpha', label: 'Alpha', models: [{ id: 'a1', label: 'A1', window: 1000 }, { id: 'a2', label: 'A2' }] },
    { id: 'beta', label: 'Beta', models: [{ id: 'b1', label: 'B1', window: 64_000 }, { id: 'q:30b', label: 'Q', window: 32_000 }] },
    { id: 'gamma', label: 'Gamma', models: [{ id: 'g1', label: 'G1' }] },
  ];
  const all = () => true;
  it('groups N providers, the session provider first, values provider:model', () => {
    const out = modelGroups(providers, 'beta', all);
    expect(out.map((o) => [o.group, o.id])).toEqual([
      ['Beta', 'beta:b1'], ['Beta', 'beta:q:30b'], ['Alpha', 'alpha:a1'], ['Alpha', 'alpha:a2'], ['Gamma', 'gamma:g1'],
    ]);
    expect(groupOptions(out).map((g) => [g.label, g.options.length])).toEqual([['Beta', 2], ['Alpha', 2], ['Gamma', 1]]);
  });
  it('with plainOwn the session provider keeps plain ids and the others are provider:model', () => {
    expect(modelGroups(providers, 'alpha', all, true).map((o) => o.id)).toEqual(['a1', 'a2', 'beta:b1', 'beta:q:30b', 'gamma:g1']);
  });
  it('leaves out a provider that is not usable but never the session provider', () => {
    expect(modelGroups(providers, 'alpha', (id) => id === 'gamma').map((o) => o.id)).toEqual(['alpha:a1', 'alpha:a2', 'gamma:g1']);
  });
  it('one provider is a flat list', () => {
    expect(groupOptions(modelGroups(providers.slice(0, 1), 'alpha', all))).toHaveLength(1);
    expect(groupOptions(modelGroups(providers.slice(0, 1), 'alpha', all))[0]!.label).toBeUndefined();
  });
  it('usableProvider: not installed or disabled (absent from the server list) is out; a failed probe is out; no probe entry is in', () => {
    const e = [{ id: 'beta', installed: true, loggedIn: false }, { id: 'gamma', installed: true, loggedIn: 'a warning' }];
    expect(usableProvider('alpha', ['alpha'], e)).toBe(true);
    expect(usableProvider('beta', ['alpha', 'beta'], e)).toBe(false);
    expect(usableProvider('gamma', ['alpha', 'gamma'], e)).toBe(true);
    expect(usableProvider('gamma', ['alpha'], e)).toBe(false);
    expect(usableProvider('alpha', undefined, [])).toBe(true);
  });
  it('typedModel: a colon names its provider, none means the session provider, blank is ignored', () => {
    expect(typedModel('beta:b9', 'alpha')).toBe('beta:b9');
    expect(typedModel('  x1  ', 'alpha')).toBe('alpha:x1');
    expect(typedModel('x1')).toBe('x1');
    expect(typedModel('   ', 'alpha')).toBeUndefined();
    expect(typedModel('', 'alpha')).toBeUndefined();
  });
  it('windowOf reads a plain id on the session provider and a provider:model of any provider', () => {
    expect(windowOf(providers, 'beta', 'b1')).toBe(64_000);
    expect(windowOf(providers, 'beta', 'alpha:a1')).toBe(1000);
    expect(windowOf(providers, 'alpha', 'beta:b1')).toBe(64_000);
    expect(windowOf(providers, 'alpha', 'beta:q:30b')).toBe(32_000);
    expect(windowOf(providers, 'beta', 'q:30b')).toBe(32_000);
    expect(windowOf(providers, 'alpha', 'beta:nope')).toBeUndefined();
    expect(windowOf(providers, 'alpha', 'a2')).toBeUndefined();
  });
  it('the context words use the window of a model of a provider other than the first', () => {
    expect(contextWords({ model: 'b1', used: 32_000, stale: false }, windowOf(providers, 'beta', 'b1')).text).toBe('Context 32k / 64k');
  });
});

describe('shownModel', () => {
  const providers = [{ id: 'claude', label: 'Claude', defaultModel: 'a', models: [{ id: 'a', label: 'A' }] }];
  const usage = { model: 'u', used: 1, stale: false };
  it("is the session's model, else the last reply's, else the provider's default", () => {
    expect(shownModel({ engine: 'claude', model: 's' }, usage, providers)).toBe('s');
    expect(shownModel({ engine: 'claude', model: null }, usage, providers)).toBe('u');
    expect(shownModel({ engine: 'claude', model: null }, undefined, providers)).toBe('a');
  });
});

describe('shownEffort', () => {
  const providers = [{ id: 'claude', label: 'Claude', defaultModel: 'a', defaultEffort: 'medium', models: [] }];
  it("is the session's level, else its provider's default (a session from before reasoning has none)", () => {
    expect(shownEffort({ engine: 'claude', effort: 'high' }, providers)).toBe('high');
    expect(shownEffort({ engine: 'claude' }, providers)).toBe('medium');
    expect(shownEffort({ engine: 'other' }, providers)).toBeUndefined();
  });
});

describe('effortBlock', () => {
  it('says why the reasoning picker is off while a turn is open, or nothing', () => {
    expect(effortBlock(true)).toBe('Change the reasoning when the session is idle.');
    expect(effortBlock(false)).toBeUndefined();
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
