// M2 Task 17a: a built-in view is plain JSON, read the same way as a mod's. The expected values below were recorded by calling each
// `fresh()` of HEAD 4a17220 once, before the views became data.
import { describe, expect, it } from 'vitest';
import type { Step, StepKind } from '@reins/core';
import { addStep, freshOf } from '../src/blocks.js';
import { KINDS } from '../src/canvasKinds.js';
import { fill } from '../src/template.js';

const HEAD_FRESH: Record<string, unknown> = {
  phase: {}, say: {}, run: { attrs: { cmd: 'npm test' } }, gate: { cond: { t: 'approve' } }, repeat: { attrs: { max: '3' }, cond: { t: 'approve' } },
  if: { cond: { t: 'approve' } }, verify: {}, recall: {}, store: {}, model: {}, subagent: {}, end: {}, fork: {}, playbook: {},   // fork and playbook: pack blocks added in M3 (Tasks 9 and 10), not ones of HEAD's
};

describe('built-in fresh', () => {
  it('is the object HEAD\'s function returned, for each of the 14 kinds that have one (every kind)', () => {
    const have = Object.keys(KINDS).filter((k) => KINDS[k as StepKind].fresh !== undefined).sort();
    expect(have).toEqual(Object.keys(HEAD_FRESH).sort());
    for (const [k, want] of Object.entries(HEAD_FRESH)) expect(KINDS[k as StepKind].fresh, k).toEqual(want);
  });
  it('survives a JSON round trip unchanged', () => {
    for (const k of Object.keys(HEAD_FRESH)) expect(JSON.parse(JSON.stringify(KINDS[k as StepKind].fresh)), k).toEqual(KINDS[k as StepKind].fresh);
  });
  it('two new blocks never share an object', () => {
    const w0 = { name: 't', budget: { turns: 1, minutes: 1 }, always: [], steps: [] } as never;
    const a = addStep(w0, 'repeat'), b = addStep(w0, 'repeat');
    const sa = a.steps[0]!, sb = b.steps[0]!;
    expect(sa.attrs).not.toBe(sb.attrs);
    expect(sa.cond).not.toBe(sb.cond);
    sa.attrs.max = '9';
    (sa.cond as { t: string }).t = 'tests';
    expect(KINDS.repeat.fresh).toEqual(HEAD_FRESH.repeat);
    expect(sb.attrs.max).toBe('3');
    const c = addStep(a, 'repeat');
    expect(c.steps[0]!.attrs.max).toBe('9');
    expect(c.steps.find((s) => s.id === 'repeat-2')!.attrs.max).toBe('3');
  });
  it('freshOf hands out a copy each time, and changing it leaves the view alone', () => {
    const a = freshOf('repeat'), b = freshOf('repeat');
    expect(a).toEqual(HEAD_FRESH.repeat);
    expect(a.attrs).not.toBe(b.attrs);
    expect(a.cond).not.toBe(b.cond);
    a.attrs!.max = '9';
    expect(freshOf('repeat')).toEqual(HEAD_FRESH.repeat);
    expect(KINDS.repeat.fresh).toEqual(HEAD_FRESH.repeat);
  });
  it('a new block is the same step as before, byte for byte', () => {
    const w0 = { name: 't', budget: { turns: 1, minutes: 1 }, always: [], steps: [] } as never;
    for (const [k, want] of Object.entries(HEAD_FRESH)) {
      expect(JSON.stringify(addStep(w0, k as StepKind).steps[0]), k).toBe(JSON.stringify({ id: `${k}-1`, kind: k, attrs: {}, cards: [], links: [], ...(want as object) }));
    }
  });
});

describe('playbook sub', () => {
  const sub = (s: Partial<Step>) => fill(KINDS.playbook.sub as string, { id: 'playbook-1', attrs: {}, ...s });
  it('is a template; the fork has one too, and no other built-in', () => {
    expect(KINDS.playbook.sub).toBe('{title|attrs.playbook|id}');
    expect(Object.values(KINDS).filter((v) => v.sub !== undefined).map((v) => v.kind)).toEqual(['fork', 'playbook']);
  });
  it('gives the title, else attrs.playbook, else the id', () => {
    expect(sub({ title: 'My title', attrs: { playbook: 'lint-fix' } })).toBe('My title');
    expect(sub({ attrs: { playbook: 'lint-fix' } })).toBe('lint-fix');
    expect(sub({})).toBe('playbook-1');
  });
});

describe('view shape', () => {
  const functionsIn = (v: unknown, at: string): string[] => {
    if (typeof v === 'function') return [at];
    if (v === null || typeof v !== 'object') return [];
    return Object.entries(v).flatMap(([k, x]) => functionsIn(x, `${at}.${k}`));
  };
  it('has no function anywhere in a built-in view, and the whole view survives JSON', () => {
    for (const v of Object.values(KINDS).slice(0, 13)) {
      expect(functionsIn(v, v.kind), v.kind).toEqual([]);
      expect(JSON.parse(JSON.stringify(v)), v.kind).toEqual(v);
    }
  });
  it('the shape check sees a function', () => {
    expect(functionsIn({ a: [{ b: () => 1 }] }, 'v')).toEqual(['v.a.0.b']);
  });
});
