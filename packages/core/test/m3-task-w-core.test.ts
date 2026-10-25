// M3 Task 8 (group W): the small pieces core keeps for the conditions and cards that left it: the helpers `api.core` hands to the pack's touches, drift and guard
// mods, and the `pack` flag of `registerCondition` (the parser answers a pack atom's complaint at once; a mod atom's waits). The pack is registered by
// setup-pack.ts, with the same order the loader reads from each manifest.
import { describe, expect, it } from 'vitest';
import { CONDS, driftFound, globMatcher, isModCond, isValidGlob, parseCond, registerCondition, relPath, type CondType, type RunEventRecord } from '../src/index.js';

const ev = (type: string, data: unknown, i = 0): RunEventRecord => ({ id: `e${i}`, timestamp: i, type: type as RunEventRecord['type'], data });

describe('the helpers a pack mod gets from api.core', () => {
  it('globMatcher is picomatch with its defaults: the touches condition matches the same paths', () => {
    expect(globMatcher('src/**/*.ts')('src/a/b.ts')).toBe(true);
    expect(globMatcher('src/**/*.ts')('lib/a.ts')).toBe(false);
    expect(globMatcher('migrations/**')('migrations/001.sql')).toBe(true);
    expect(globMatcher('*.md')('.hidden.md')).toBe(false);   // dot files are not matched by default
    expect(globMatcher('*.md')('README.md')).toBe(true);
  });

  it('isValidGlob is core\'s own check (the guard card and the validator use the same one)', () => {
    expect(isValidGlob('src/**')).toBe(true);
    expect(isValidGlob('src/[bad')).toBe(false);
    expect(isValidGlob('')).toBe(false);
  });

  it('relPath is the policy\'s own', () => {
    expect(relPath('C:\\work\\src\\a.ts', 'c:/work')).toBe('src/a.ts');
    expect(relPath('/elsewhere/a.ts', '/work')).toBe('/elsewhere/a.ts');
  });

  it('driftFound is true when any of the four signals fires, false for none', () => {
    const tool = (i: number, input: unknown) => ev('tool_call', { tool: 'Read', input }, i);
    expect(driftFound([])).toBe(false);
    expect(driftFound([tool(0, { a: 1 }), tool(1, { a: 2 })])).toBe(false);
    expect(driftFound([tool(0, { a: 1 }), tool(1, { a: 1 }), tool(2, { a: 1 })])).toBe(true);                              // repeated action
    expect(driftFound(Array.from({ length: 26 }, (_, i) => tool(i, { n: i })))).toBe(true);                                // stagnation
    expect(driftFound([ev('refusal', { reason: 'edit in read-only mode' })])).toBe(true);                                  // edit before plan
    expect(driftFound([ev('tool_call', { tool: 'Bash', exitCode: 1, output: 'boom 1' }, 0), ev('tool_call', { tool: 'Bash', exitCode: 1, output: 'boom 2' }, 1)])).toBe(true);   // same error
  });
});

describe('registerCondition: the pack flag', () => {
  const later = (t = 'attemptsish'): CondType => ({ t, parse(s) { if (!s.src.startsWith('attempts', s.idx)) return null; s.idx = s.len; return { t } as never; }, print: () => t, judge: 'agent' });

  it('core registers no atom of its own: the pack is what setup-pack.ts registered, and every one of them is flagged as the pack\'s', () => {
    expect([...CONDS.keys()].length).toBe(11);
    for (const c of CONDS.values()) expect(isModCond(c), c.t).toBe(false);
  });

  it('an atom registered without the flag is a mod\'s: its diagnostic waits, so a pack atom\'s complaint is the answer', () => {
    const mine = later();
    const off = registerCondition(mine, 500);
    try {
      expect(isModCond(mine)).toBe(true);
      expect(parseCond('attempts > x').diag?.message).toBe('Expected integer after "attempts >"');   // the pack atom answered; the later atom never got the text
    } finally {
      off();
    }
    expect(CONDS.has('attemptsish')).toBe(false);
  });

  it('a user atom ahead of the pack, with a complaint of its own, is held back until no other atom takes the text', () => {
    const early: CondType = { t: 'early', parse(s) { if (!s.src.startsWith('tests', s.idx)) return null; return s.error('early complaint'); }, print: () => 'early', judge: 'agent' };
    const off = registerCondition(early, 5);
    try {
      expect(parseCond('tests pass').cond).toEqual({ t: 'tests' });
    } finally {
      off();
    }
  });

  it('the pack flag is forgotten with the entry', () => {
    const a = later('flagged');
    const off = registerCondition(a, 500, { pack: true });
    expect(isModCond(a)).toBe(false);
    off();
    expect(CONDS.has('flagged')).toBe(false);
    expect(isModCond(a)).toBe(true);
    off();   // a second call does nothing
    expect(isModCond(a)).toBe(true);
  });
});
