// Which provider a new session gets when the request names none (Milestone P, Task 6).
import { describe, it, expect } from 'vitest';
import { defaultProviderOf, type ProviderView } from '../src/engines.js';

const view = (id: string, extra: Partial<ProviderView> = {}): ProviderView => ({
  id, label: id, defaultModel: 'm', defaultEffort: '', efforts: [], models: [], prices: {}, ...extra,
});

describe('defaultProviderOf', () => {
  // `aaa` sorts first and is not the default on purpose: the order of the list must not decide.
  const views = [view('aaa'), view('mmm', { default: true }), view('zzz')];

  it('the setting wins when it names an installed provider', () => {
    expect(defaultProviderOf(views, 'zzz')?.id).toBe('zzz');
  });

  it('the provider whose manifest says default wins over the first in the list', () => {
    expect(defaultProviderOf(views, '')?.id).toBe('mmm');
  });

  it('a setting that names nothing installed falls back to the manifest default, not the first', () => {
    expect(defaultProviderOf(views, 'gone')?.id).toBe('mmm');
  });

  it('with no manifest default, the first installed one', () => {
    expect(defaultProviderOf([view('bbb'), view('ccc')], '')?.id).toBe('bbb');
  });

  it('nothing installed: nothing', () => {
    expect(defaultProviderOf([], '')).toBeUndefined();
  });
});
