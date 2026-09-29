import { describe, it, expect } from 'vitest';
import { parseCond, printCond, judgeOf } from '../src/cond.js';
import type { Cond } from '../src/model.js';

describe('Task 1.3: Condition Language', () => {
  it('parses every atom in §5.4', () => {
    const atoms: [string, Cond][] = [
      ['you approve', { t: 'approve' }],
      ['tests pass', { t: 'tests' }],
      ['`npm test` passes', { t: 'cmd', cmd: 'npm test' }],
      ['llm says "the plan covers all requirements"', { t: 'llm', q: 'the plan covers all requirements' }],
      ['reviewer approves', { t: 'review' }],
      ['reviewer approves "strict mode"', { t: 'review', q: 'strict mode' }],
      ['agent says done', { t: 'done' }],
      ['diff > 300 lines', { t: 'diff', n: 300 }],
      ['touches migrations/**', { t: 'touches', glob: 'migrations/**' }],
      ['attempts > 5', { t: 'attempts', n: 5 }],
      ['same error twice', { t: 'same' }],
      ['drift', { t: 'drift' }],
    ];

    for (const [src, expected] of atoms) {
      const res = parseCond(src);
      expect(res.diag).toBeUndefined();
      expect(res.cond).toEqual(expected);
    }
  });

  it('binds and tighter than or', () => {
    const res1 = parseCond('tests pass or agent says done and drift');
    expect(res1.cond).toEqual({
      t: 'or',
      a: { t: 'tests' },
      b: {
        t: 'and',
        a: { t: 'done' },
        b: { t: 'drift' },
      },
    });

    const res2 = parseCond('agent says done and drift or tests pass');
    expect(res2.cond).toEqual({
      t: 'or',
      a: {
        t: 'and',
        a: { t: 'done' },
        b: { t: 'drift' },
      },
      b: { t: 'tests' },
    });
  });

  it('handles not and brackets', () => {
    const res1 = parseCond('not tests pass');
    expect(res1.cond).toEqual({
      t: 'not',
      a: { t: 'tests' },
    });

    const res2 = parseCond('(tests pass or agent says done) and drift');
    expect(res2.cond).toEqual({
      t: 'and',
      a: {
        t: 'or',
        a: { t: 'tests' },
        b: { t: 'done' },
      },
      b: { t: 'drift' },
    });

    const res3 = parseCond('not (tests pass or drift)');
    expect(res3.cond).toEqual({
      t: 'not',
      a: {
        t: 'or',
        a: { t: 'tests' },
        b: { t: 'drift' },
      },
    });
  });

  it('round-trips canonical forms with print(parse(s)) === s', () => {
    const canonicals = [
      'you approve',
      'tests pass',
      '`npm test` passes',
      'llm says "plan is ready"',
      'reviewer approves',
      'reviewer approves "strict"',
      'agent says done',
      'diff > 300 lines',
      'touches migrations/**',
      'attempts > 5',
      'same error twice',
      'drift',
      'not tests pass',
      'tests pass and drift',
      'tests pass or drift',
      '(tests pass or drift) and agent says done',
      'not (tests pass or drift)',
    ];

    for (const s of canonicals) {
      const parsed = parseCond(s);
      expect(parsed.diag).toBeUndefined();
      expect(printCond(parsed.cond!)).toBe(s);
    }
  });

  it('points errors to the right column', () => {
    const res1 = parseCond('diff > x lines');
    expect(res1.cond).toBeUndefined();
    expect(res1.diag).toBeDefined();
    expect(res1.diag?.pos).toEqual({ line: 1, col: 8 });

    const res2 = parseCond('diff > x lines', { line: 5, col: 10 });
    expect(res2.diag?.pos).toEqual({ line: 5, col: 17 });

    const res3 = parseCond('foobar');
    expect(res3.cond).toBeUndefined();
    expect(res3.diag).toBeDefined();
    expect(res3.diag?.pos).toEqual({ line: 1, col: 1 });
  });

  it('judgeOf returns the right judge for each atom', () => {
    expect(judgeOf({ t: 'approve' })).toBe('you');
    expect(judgeOf({ t: 'tests' })).toBe('command');
    expect(judgeOf({ t: 'cmd', cmd: 'npm test' })).toBe('command');
    expect(judgeOf({ t: 'diff', n: 10 })).toBe('deterministic');
    expect(judgeOf({ t: 'touches', glob: '*.ts' })).toBe('deterministic');
    expect(judgeOf({ t: 'attempts', n: 3 })).toBe('deterministic');
    expect(judgeOf({ t: 'same' })).toBe('deterministic');
    expect(judgeOf({ t: 'drift' })).toBe('deterministic');
    expect(judgeOf({ t: 'done' })).toBe('agent');
    expect(judgeOf({ t: 'llm', q: 'ok?' })).toBe('model');
    expect(judgeOf({ t: 'review' })).toBe('subagent');
  });
});
