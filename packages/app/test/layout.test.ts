import { describe, expect, it } from 'vitest';
import type { Step } from '@reins/core';
import { GAP, HEAD, NODE_H, NODE_W, PAD, layout } from '../src/layout.js';

const s = (id: string, kind = 'phase', kids?: Step[], els?: Step[]): Step => {
  const st = { id, kind, attrs: {}, cards: [], links: [] } as unknown as Step;
  if (kids) st.kids = kids;
  if (els) st.else = els;
  return st;
};

describe('layout', () => {
  it('stacks top-level steps in a column', () => {
    const b = layout([s('a'), s('b')]);
    expect(b.a).toMatchObject({ x: 0, y: 0, w: NODE_W, h: NODE_H });
    expect(b.b!.x).toBe(b.a!.x);
    expect(b.b!.y).toBe(NODE_H + GAP);
  });

  it('puts group kids relative to the group and sizes the group around them', () => {
    const b = layout([s('r', 'repeat', [s('k1'), s('k2')])]);
    expect(b.k1).toMatchObject({ x: PAD, y: HEAD });
    expect(b.k2!.y).toBe(HEAD + NODE_H + GAP);
    expect(b.r!.h).toBe(HEAD + 2 * NODE_H + GAP + PAD);
    expect(b.r!.w).toBe(PAD + NODE_W + PAD);
  });

  it('puts an if else-column to the right of the then-column', () => {
    const b = layout([s('i', 'if', [s('y')], [s('n')])]);
    expect(b.i!.elseX).toBeGreaterThan(b.y!.x + NODE_W);
    expect(b.n!.x).toBe(b.i!.elseX);
    expect(b.n!.y).toBe(HEAD);
    expect(b.i!.w).toBe(b.n!.x + NODE_W + PAD);
  });

  it('centres a narrow step under a wide group', () => {
    const b = layout([s('r', 'repeat', [s('k')]), s('after')]);
    expect(b.after!.x).toBe((b.r!.w - NODE_W) / 2);
    expect(b.after!.x).toBeGreaterThan(0);
  });

  it('a saved position moves only that step', () => {
    const steps = [s('plan'), s('build')];
    const auto = layout(steps);
    const b = layout(steps, { plan: { x: 500, y: 7 } });
    expect(b.plan).toMatchObject({ x: 500, y: 7, w: NODE_W, h: NODE_H });
    expect(b.build).toEqual(auto.build);
  });

  it('a saved kid dragged out grows its group', () => {
    const b = layout([s('r', 'repeat', [s('k')])], { k: { x: 400, y: 50 } });
    expect(b.r!.w).toBe(400 + NODE_W + PAD);
    expect(b.r!.h).toBe(50 + NODE_H + PAD);
  });

  it('grows nested groups deepest first', () => {
    const b = layout([s('o', 'repeat', [s('i', 'repeat', [s('k')])])], { k: { x: 400, y: 50 } });
    expect(b.i!.w).toBe(400 + NODE_W + PAD);
    expect(b.o!.w).toBeGreaterThanOrEqual(b.i!.x + b.i!.w + PAD);
  });

  it('ignores a saved id that is not a step', () => {
    const steps = [s('a'), s('b')];
    expect(layout(steps, { ghost: { x: 1, y: 2 } })).toEqual(layout(steps));
  });

  it('an empty group is NODE_W by HEAD + PAD', () => {
    expect(layout([s('r', 'repeat', [])]).r).toMatchObject({ w: NODE_W, h: HEAD + PAD });
  });

  it('empty steps give {}', () => {
    expect(layout([])).toEqual({});
  });
});
