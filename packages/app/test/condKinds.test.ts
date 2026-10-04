import { describe, expect, it } from 'vitest';
import { CONDS, parseCond, printCond, type Cond } from '@reins/core';
import { applyParam, COND_KINDS } from '../src/condKinds.js';

const round = (c: Cond) => parseCond(printCond(c));
const atom = (t: string, over: object = {}) => ({ ...COND_KINDS[t]!.fresh(), ...over }) as Cond;

describe('COND_KINDS', () => {
  it('has exactly the core atoms', () => {
    expect(Object.keys(COND_KINDS).sort()).toEqual([...CONDS.keys()].sort());
  });
  it('has unique labels', () => {
    const labels = Object.values(COND_KINDS).map((k) => k.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
  it('prints every fresh atom and reads it back unchanged', () => {
    for (const [t, k] of Object.entries(COND_KINDS)) {
      const r = round(k.fresh());
      expect(r.diag, t).toBeUndefined();
      expect(r.cond, t).toEqual(k.fresh());
    }
  });
  it('makes a new object per call', () => {
    for (const k of Object.values(COND_KINDS)) expect(k.fresh()).not.toBe(k.fresh());
  });
});

describe('applyParam', () => {
  const good: Array<[string, string, object]> = [
    ['attempts', '5', { n: 5 }],
    ['diff', '120', { n: 120 }],
    ['llm', "it's fine", { q: "it's fine" }],
    ['touches', 'src/**', { glob: 'src/**' }],
    ['cmd', 'npm run x', { cmd: 'npm run x' }],
    ['review', 'is it ok', { q: 'is it ok' }],
  ];
  it.each(good)('%s %j round-trips', (t, v, expected) => {
    const n = applyParam(atom(t), v)!;
    expect(n).toEqual({ t, ...expected });
    expect(round(n).cond).toEqual(n);
  });
  it('review with an empty question drops it', () => {
    expect(applyParam(atom('review', { q: 'x' }), '')).toEqual({ t: 'review' });
    expect(round({ t: 'review' }).cond).toEqual({ t: 'review' });
  });
  const bad: Array<[string, string]> = [
    ['attempts', '-1'], ['attempts', '2.5'], ['attempts', 'x'], ['attempts', '1234567890'], ['attempts', ''],
    ['diff', '1234567890'],
    ['llm', 'a"b'], ['llm', 'a\\b'], ['llm', 'a\\'],
    ['review', 'a"b'], ['review', 'a\\b'],
    ['cmd', 'a`b'], ['cmd', ''],
    ['touches', ''], ['touches', 'a b'], ['touches', 'a)'],
  ];
  it.each(bad)('%s %j is refused', (t, v) => {
    expect(applyParam(atom(t), v)).toBeUndefined();
  });
  it('accepts a 9 digit number', () => {
    expect(applyParam(atom('attempts'), '123456789')).toEqual({ t: 'attempts', n: 123456789 });
  });
  it('refuses an atom with no parameter, and a compound', () => {
    expect(applyParam(atom('approve'), 'x')).toBeUndefined();
    expect(applyParam({ t: 'not', a: atom('approve') }, 'x')).toBeUndefined();
  });
  it('never mutates', () => {
    const c = atom('llm');
    const copy = structuredClone(c);
    applyParam(c, 'new');
    applyParam(c, 'a"b');
    expect(c).toEqual(copy);
  });
});
