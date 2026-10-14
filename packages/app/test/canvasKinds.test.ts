import { describe, expect, it } from 'vitest';
import { CARDS, NODES, parseWorkflow, printWorkflow, validate, type Step, type StepKind } from '@reins/core';
import { CARD_KINDS, KINDS } from '../src/canvasKinds.js';
import { BUDGET_ERRORS, applyField } from '../src/panelEdit.js';

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
  it('only end stops the workflow', () => {
    expect((Object.keys(KINDS) as StepKind[]).filter((k) => KINDS[k].stops)).toEqual(['end']);
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

describe('field hints', () => {
  it('the budget of a model and a subagent says optional', () => {
    for (const k of ['model', 'subagent'] as const) expect(KINDS[k].fields.find((f) => f.key === 'usd')!.ph, k).toBe('optional');
  });
  it('a prompt is required exactly where the validator warns about a missing one', () => {
    const base = '---\nreins: 1\nname: t\nbudget: { turns: 10, minutes: 30 }\nalways: []\n---\n\n## phase plan\n> Plan it.\n';
    for (const k of (Object.keys(KINDS) as StepKind[]).filter((x) => KINDS[x].fields.some((f) => f.key === 'prompt'))) {
      const w = parseWorkflow(base).workflow!;
      w.steps.push({ id: `${k}-1`, kind: k, attrs: {}, cards: [], links: [], ...KINDS[k].fresh!() });
      const warns = validate(w).some((d) => d.severity === 'warning' && d.message.includes('has no prompt'));
      expect(!!KINDS[k].fields.find((f) => f.key === 'prompt')!.required, k).toBe(warns);
    }
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
  it('model: a fresh step prints `## model`, and one with a model and a slice prints both', () => {
    expect(KINDS.model.fields.map((f) => f.key)).toEqual(['model', 'usd']);
    const base = '---\nreins: 1\nname: t\nbudget: { turns: 10, minutes: 30, usd: 2.00 }\nalways: []\n---\n\n## phase plan\n> Plan it.\n';
    const w = parseWorkflow(base).workflow!;
    w.steps.push({ id: 'model-1', kind: 'model', attrs: { model: 'x', usd: '0.50' }, cards: [], links: [] });
    expect(printWorkflow(w)).toContain('## model x\nusd: 0.50\n');
  });
  // the generic loops above (`fresh`, `line`, `card`, `fields only name keys the kind owns`, nodes-registry) iterate KINDS, so this kind is covered by them once the entry exists
  it('subagent: its fields are in tab order, and a title, a model and a slice print and read back', () => {
    expect(KINDS.subagent.fields.map((f) => f.key)).toEqual(['title', 'prompt', 'mode', 'model', 'usd']);
    expect(KINDS.subagent.fields.find((f) => f.key === 'model')!.inherits).toBe(true);
    expect(KINDS.model.fields.find((f) => f.key === 'model')!.inherits).toBeUndefined();
    const base = '---\nreins: 1\nname: t\nbudget: { turns: 10, minutes: 30, usd: 2.00 }\nalways: []\n---\n\n## phase plan\n> Plan it.\n';
    const w = parseWorkflow(base).workflow!;
    w.steps.push({ id: 'subagent-1', kind: 'subagent', title: 'research', attrs: { model: 'x', usd: '0.50' }, prompt: 'Look.', cards: [], links: [] });
    const text = printWorkflow(w);
    expect(text).toContain('## subagent research\nmodel: x\nusd: 0.50\n> Look.');
    const back = parseWorkflow(text);
    expect(back.diagnostics).toEqual([]);
    expect(back.workflow!.steps[1]).toMatchObject({ kind: 'subagent', title: 'research', attrs: { model: 'x', usd: '0.50' }, prompt: 'Look.' });
    expect(KINDS.subagent.cards).toBe(true);
  });

  it('subagent: the panel labels, the Budget (USD) refusal words, the face line and the palette card are exactly the plan\'s', () => {
    expect(KINDS.subagent.fields.map((f) => f.label)).toEqual(['Title', 'Prompt', 'Mode', 'Model', 'Budget (USD)']);
    expect(KINDS.subagent.fields.find((f) => f.key === 'usd')!.error).toBe(BUDGET_ERRORS.usd);
    expect(KINDS.subagent.line).toEqual(['subagent', { field: 'title' }, 'on', { field: 'model' }, { field: 'mode' }, 'USD', { field: 'usd' }, { field: 'prompt' }]);
    expect(KINDS.subagent.card).toEqual({ label: 'subagent', section: 'Flow' });
    const s = { id: 'subagent-1', kind: 'subagent', attrs: { usd: '0.50' }, cards: [], links: [] } as unknown as Step;
    expect(applyField(s, 'usd', 'abc')).toBe(false);
    expect(s.attrs.usd).toBe('0.50');
  });
  it('gives a new attrs object per call', () => {
    expect(KINDS.repeat.fresh!().attrs).not.toBe(KINDS.repeat.fresh!().attrs);
  });
});