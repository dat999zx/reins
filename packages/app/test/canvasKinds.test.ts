import { describe, expect, it } from 'vitest';
import { CARDS, NODES, type Step } from '@reins/core';
import { CARD_KINDS, KINDS } from '../src/canvasKinds.js';

const step = (kind: string, over: Partial<Step> = {}): Step =>
  ({ id: 'x', kind, attrs: {}, cards: [], links: [], ...over }) as Step;

describe('KINDS', () => {
  it('has exactly the core node kinds', () => {
    expect(Object.keys(KINDS).sort()).toEqual([...NODES.keys()].sort());
  });
  it('mirrors fails and container from core', () => {
    for (const k of NODES.keys()) {
      const view = KINDS[k as keyof typeof KINDS];
      expect(!!view.fails, k).toBe(!!NODES.get(k)!.fails);
      expect(view.group, k).toBe(NODES.get(k)!.container);
    }
  });
  it('fields only name keys the kind owns', () => {
    for (const k of NODES.keys()) {
      const n = NODES.get(k)!;
      const ok = new Set(['title', 'prompt', ...n.attrs, ...(n.heading?.owns ?? [])]);
      for (const f of KINDS[k as keyof typeof KINDS].fields) expect(ok.has(f.key), `${k}.${f.key}`).toBe(true);
    }
  });
  it('CARD_KINDS is the core cards without whenever-only kinds, in order', () => {
    expect(CARD_KINDS).toEqual([...CARDS.values()].filter((c) => !c.delivery).map((c) => c.kind));
  });
  it('sub gives the second line', () => {
    expect(KINDS.run.sub(step('run', { attrs: { cmd: 'npm test' } }))).toBe('npm test');
    expect(KINDS.gate.sub(step('gate'), 'tests pass')).toBe('until tests pass');
    expect(KINDS.verify.sub(step('verify', { attrs: { against: 'plan' } }))).toBe('against plan');
    expect(KINDS.use.sub(step('use', { attrs: { use: 'lint-fix' } }))).toBe('lint-fix');
    expect(KINDS.repeat.sub(step('repeat', { attrs: { max: '3' } }), 'tests pass')).toBe('until tests pass · max 3');
    expect(KINDS.if.sub(step('if'), 'tests pass')).toBe('if tests pass');
    expect(KINDS.handoff.sub(step('handoff', { attrs: { to: 'bob' } }))).toBe('bob');
    expect(KINDS.recall.sub(step('recall', { attrs: { knowl: 'k' } }))).toBe('k');
    expect(KINDS.say.sub(step('say', { prompt: `${'a'.repeat(50)}\nsecond` }))).toBe('a'.repeat(40));
  });
});
