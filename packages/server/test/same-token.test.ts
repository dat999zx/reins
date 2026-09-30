// The token comparison behind the hook route and the HTTP API (plan 15d 3b.7, line 1552).
import { describe, it, expect } from 'vitest';
import { sameToken } from '../src/hooks.js';

describe('sameToken', () => {
  it('is true only for the same bytes', () => {
    expect(sameToken('abc', 'abc')).toBe(true);
    expect(sameToken('abc', 'abd')).toBe(false);
    expect(sameToken('abc', 'ab')).toBe(false);
  });

  it('a non-ASCII string of the same length as the token is false and does not throw', () => {
    const token = 'a'.repeat(64);
    const almost = 'a'.repeat(63) + 'é';
    expect(almost).toHaveLength(64);
    expect(() => sameToken(almost, token)).not.toThrow();
    expect(sameToken(almost, token)).toBe(false);
  });

  it('two different non-ASCII strings of the same byte length are false', () => {
    expect(sameToken('é', 'è')).toBe(false);
  });
});
