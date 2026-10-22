import { describe, it, expect } from 'vitest';
import { Registry as FromCore } from '@reins/core';
import { Registry as FromMods } from '../src/mods/registry.js';

describe('the mods registry is core\'s Registry', () => {
  it('is the same class, so existing imports keep working', () => {
    expect(FromMods).toBe(FromCore);
  });

  it('keeps the provider behaviour: a shadow covers, disposing brings the first back, ids are sorted', () => {
    const r = new FromMods();
    r.register('provider', 'b', 'first');
    r.register('provider', 'a', 'x');
    const d = r.register('provider', 'b', 'copy', { shadow: true });
    expect(r.get('provider', 'b')).toBe('copy');
    expect(r.ids('provider')).toEqual(['a', 'b']);
    d(); d();
    expect(r.get('provider', 'b')).toBe('first');
    expect(r.list('provider')).toEqual(['first', 'x']);
  });
});
