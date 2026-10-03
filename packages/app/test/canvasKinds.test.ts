import { describe, expect, it } from 'vitest';
import { CARDS, NODES, parseWorkflow, printWorkflow, validate, type Step, type StepKind } from '@reins/core';
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

describe('fresh', () => {
  const withFresh = [...NODES.keys()].filter((k) => k !== 'use').sort();
  it('exists for every kind but use', () => {
    expect((Object.keys(KINDS) as StepKind[]).filter((k) => KINDS[k].fresh).sort()).toEqual(withFresh);
  });
  for (const k of withFresh) {
    it(`${k}: prints, reads back with no errors, same bytes, default id`, () => {
      const base = '---\nreins: 1\nname: t\nbudget: { turns: 10, minutes: 30 }\nalways: []\n---\n\n## phase plan\n> Plan it.\n';
      const w = parseWorkflow(base).workflow!;
      w.steps.push({ id: `${k}-1`, kind: k as StepKind, attrs: {}, cards: [], links: [], ...KINDS[k as StepKind].fresh!() });
      const text = printWorkflow(w);
      const r = parseWorkflow(text);
      expect(r.diagnostics).toEqual([]);
      expect(validate(r.workflow!).filter((d) => d.severity === 'error')).toEqual([]);
      expect(printWorkflow(r.workflow!)).toBe(text);
      expect(r.workflow!.steps[1]!.id).toBe(`${k}-1`);
      expect(text).not.toContain('\nid:');
    });
  }
  it('gives a new attrs object per call', () => {
    expect(KINDS.repeat.fresh!().attrs).not.toBe(KINDS.repeat.fresh!().attrs);
  });
});