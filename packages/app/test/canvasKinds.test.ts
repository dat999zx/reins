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
  it('only use has sub', () => {
    expect((Object.keys(KINDS) as StepKind[]).filter((k) => KINDS[k].sub)).toEqual(['use']);
    expect(KINDS.use.sub!(step('use', { attrs: { use: 'lint-fix' } }))).toBe('lint-fix');
  });
});

describe('line', () => {
  const kinds = Object.keys(KINDS) as StepKind[];
  it('every kind has a non-empty row', () => {
    for (const k of kinds) expect(KINDS[k].line.length, k).toBeGreaterThan(0);
  });
  it('every field token is one of the kind fields', () => {
    for (const k of kinds) for (const t of KINDS[k].line) if (typeof t === 'object') expect(KINDS[k].fields.map((f) => f.key), k).toContain(t.field);
  });
  it("'cond' is in exactly the kinds whose fresh step has a cond", () => {
    const withCond = kinds.filter((k) => KINDS[k].line.includes('cond')).sort();
    expect(withCond).toEqual(['gate', 'if', 'repeat']);
    expect(kinds.filter((k) => KINDS[k].fresh?.().cond).sort()).toEqual(withCond);
  });
});

describe('card', () => {
  const kinds = Object.keys(KINDS) as StepKind[];
  it('exactly the kinds that can be added have a palette card', () => {
    expect(kinds.filter((k) => KINDS[k].card).sort()).toEqual(kinds.filter((k) => KINDS[k].fresh).sort());
  });
  it('labels are unique and sections are Flow or Memory', () => {
    const cards = kinds.flatMap((k) => (KINDS[k].card ? [KINDS[k].card!] : []));
    expect(new Set(cards.map((c) => c.label)).size).toBe(cards.length);
    for (const c of cards) expect(['Flow', 'Memory']).toContain(c.section);
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