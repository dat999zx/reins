import { describe, expect, it } from 'vitest';
import { parseWorkflow, printWorkflow, type Step } from '@reins/core';
import { addLoose, attach, detach, ensureEnd, freedBy, HOME, moveItems, nextKey, park, pruneLayout, removeLoose, selfContained, splitAtEnd, stateBytes, unpark } from '../src/arrange.js';
import { flatSteps } from '../src/canvas.js';
import { LOOSE_MAX, type Layout } from '../src/editorState.js';

const HEAD = '---\nreins: 1\nname: demo\nbudget: { turns: 10, minutes: 30 }\nalways: []\n---\n\n';
const steps = parseWorkflow(`${HEAD}## phase plan\nnext: build\n\n## repeat\nid: r\nuntil: tests pass\nmax: 3\n\n### phase a\nnext: plan\n\n### phase b\n\n## verify\nid: v\nagainst: plan\n`).workflow!.steps;
const [plan, repeat, verify] = steps as [Step, Step, Step];
const mk = (id: string): Step => ({ id, kind: 'phase', attrs: {}, cards: [], links: [] });

describe('addLoose / removeLoose / nextKey', () => {
  it('adds steps at points with unique keys, in order', () => {
    const r = addLoose({}, [mk('a'), mk('b')], [{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    expect(r.keys).toEqual(['l1', 'l2']);
    expect(r.lay.loose).toEqual([{ key: 'l1', at: { x: 1, y: 2 }, step: mk('a') }, { key: 'l2', at: { x: 3, y: 4 }, step: mk('b') }]);
    const more = addLoose(r.lay, [mk('c')], [{ x: 0, y: 0 }]);
    expect(new Set(more.lay.loose!.map((l) => l.key)).size).toBe(3);
  });
  it('a key freed by a delete is reused, never one still in use', () => {
    const lay = addLoose({}, [mk('a'), mk('b'), mk('c')], [HOME, HOME, HOME]).lay;
    const cut = removeLoose(lay, ['l1']);
    expect(nextKey(cut)).toBe('l1');
    expect(nextKey(lay)).toBe('l4');
  });
  it('refuses to cross the cap', () => {
    const full = addLoose({}, Array.from({ length: LOOSE_MAX }, (_, i) => mk(`s${i}`)), Array.from({ length: LOOSE_MAX }, () => HOME)).lay;
    expect(full.loose).toHaveLength(LOOSE_MAX);
    const r = addLoose(full, [mk('x')], [HOME]);
    expect(r.keys).toEqual([]);
    expect(r.lay).toBe(full);
  });
  it('removeLoose drops the keys; the same layout when none match', () => {
    const lay = addLoose({ script: { x: 1, y: 1 } }, [mk('a'), mk('b')], [HOME, HOME]).lay;
    expect(removeLoose(lay, ['l1']).loose!.map((l) => l.key)).toEqual(['l2']);
    expect(removeLoose(lay, ['l1']).script).toEqual({ x: 1, y: 1 });
    expect(removeLoose(lay, ['zz'])).toBe(lay);
    expect(removeLoose({}, ['l1'])).toEqual({});
  });
  it('never mutates its input', () => {
    const lay: Layout = { loose: [{ key: 'l1', at: { x: 1, y: 1 }, step: mk('a') }] };
    const snap = JSON.stringify(lay);
    addLoose(lay, [mk('b')], [HOME]); removeLoose(lay, ['l1']); moveItems(lay, ['l:l1'], { x: 5, y: 5 });
    expect(JSON.stringify(lay)).toBe(snap);
  });
});

describe('moveItems', () => {
  const lay: Layout = { script: { x: 10, y: 10 }, loose: [{ key: 'l1', at: { x: 1, y: 1 }, step: mk('a') }, { key: 'l2', at: { x: 2, y: 2 }, step: mk('b') }] };
  it('moves the hat from its place, or from HOME when it has none', () => {
    expect(moveItems(lay, ['hat'], { x: 5, y: -5 }).script).toEqual({ x: 15, y: 5 });
    expect(moveItems({}, ['hat'], { x: 5, y: 5 }).script).toEqual({ x: HOME.x + 5, y: HOME.y + 5 });
  });
  it('moves only the named loose blocks', () => {
    const m = moveItems(lay, ['l:l2'], { x: 3, y: 4 });
    expect(m.loose!.map((l) => l.at)).toEqual([{ x: 1, y: 1 }, { x: 5, y: 6 }]);
    expect(m.script).toEqual({ x: 10, y: 10 });
  });
  it('moves the hat and loose blocks together', () => {
    const m = moveItems(lay, ['hat', 'l:l1'], { x: 1, y: 1 });
    expect(m.script).toEqual({ x: 11, y: 11 });
    expect(m.loose![0]!.at).toEqual({ x: 2, y: 2 });
  });
});

describe('selfContained', () => {
  it('strips links and against that leave the copy, keeps those inside, strips pos', () => {
    const [p] = selfContained([plan]);
    expect(p!.links).toEqual([]);
    const [r] = selfContained([repeat]);
    expect(r!.kids![0]!.links).toEqual([]); // a -> plan is outside the copy
    const [r2, p2] = selfContained([repeat, plan]);
    expect(r2!.kids![0]!.links).toMatchObject([{ kind: 'next', to: 'plan' }]); // inside the copy now
    expect(p2!.links).toEqual([]); // build is not in the copy
    const [v] = selfContained([verify]);
    expect(v!.attrs.against).toBeUndefined();
    const [v2] = selfContained([plan, verify]).slice(1);
    expect(v2!.attrs.against).toBe('plan');
    expect(JSON.stringify(selfContained([repeat, plan]))).not.toContain('"pos"');
  });
  it('prints and parses as a workflow', () => {
    const text = printWorkflow({ ...parseWorkflow(`${HEAD}## phase x\n`).workflow!, steps: selfContained([repeat]) });
    expect(parseWorkflow(text).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
  it('never mutates its input', () => {
    const snap = JSON.stringify(steps);
    selfContained(steps);
    expect(JSON.stringify(steps)).toBe(snap);
  });
});

const PW = parseWorkflow(`${HEAD}## phase plan\nnext: build\n\n## phase build\n\n## run \`npm test\`\nid: t\non-fail: fix\n\n## phase fix\nnext: t (max 3)\n\n## verify\nid: v\nagainst: fix\n\n## repeat\nid: r\nuntil: tests pass\nmax: 3\n\n### phase a\nnext: plan (max 2)\n\n### phase b\n`).workflow!;
const idsOf = (w: typeof PW) => flatSteps(w.steps).map((s) => s.id);
const errors = (w: typeof PW) => parseWorkflow(printWorkflow(w)).diagnostics.filter((d) => d.severity === 'error');

describe('park', () => {
  it('takes the step out, drops links and against that point into it, reports each', () => {
    const r = park(PW, ['fix']);
    expect(idsOf(r.w)).not.toContain('fix');
    expect(flatSteps(r.w.steps).find((s) => s.id === 't')!.links).toEqual([]);
    expect(flatSteps(r.w.steps).find((s) => s.id === 'v')!.attrs.against).toBeUndefined();
    expect(r.steps.map((s) => s.id)).toEqual(['fix']);
    expect(r.steps[0]!.links).toEqual([]); // fix -> t leaves the copy
    expect(r.lost).toEqual(['`t` on-fail → `fix`', '`fix` next → `t`', '`v` against → `fix`']);
    expect(errors(r.w)).toEqual([]);
  });
  it('keeps links inside the parked set; a C block goes with its children; pos is stripped', () => {
    const r = park(PW, ['t', 'fix']);
    expect(r.steps.map((s) => s.id)).toEqual(['t', 'fix']);
    expect(r.steps[0]!.links).toMatchObject([{ kind: 'on-fail', to: 'fix' }]);
    expect(r.steps[1]!.links).toMatchObject([{ kind: 'next', to: 't', max: 3 }]);
    expect(r.lost).toEqual(['`v` against → `fix`']);
    const c = park(PW, ['r']);
    expect(c.steps[0]!.kids!.map((s) => s.id)).toEqual(['a', 'b']);
    expect(c.steps[0]!.kids![0]!.links).toEqual([]); // a -> plan leaves the copy
    expect(c.lost).toEqual(['`a` next → `plan`']);
    expect(idsOf(c.w)).not.toContain('a');
    expect(JSON.stringify(c.steps)).not.toContain('"pos"');
  });
  it('parks a nested step; an unknown id changes nothing', () => {
    expect(idsOf(park(PW, ['a']).w)).not.toContain('a');
    expect(idsOf(park(PW, ['a']).w)).toContain('r');
    const none = park(PW, ['nope']);
    expect(none.w).toBe(PW);
    expect(none.steps).toEqual([]);
    expect(none.lost).toEqual([]);
  });
  it('never mutates its input', () => {
    const snap = JSON.stringify(PW);
    park(PW, ['fix', 'r']);
    expect(JSON.stringify(PW)).toBe(snap);
  });
});

describe('unpark', () => {
  const at = { branch: 'kids' as const, index: 0 };
  it('inserts the steps and returns their ids', () => {
    const parked = park(PW, ['build']);
    const r = unpark(parked.w, parked.steps, { branch: 'kids', index: 1 });
    expect(r.ids).toEqual(['build']);
    expect(idsOf(r.w).slice(0, 2)).toEqual(['plan', 'build']);
    expect(errors(r.w)).toEqual([]);
  });
  it('renames on a collision, also two in one call', () => {
    const [p] = PW.steps as [Step];
    const one = unpark(PW, [p], at);
    expect(one.ids).toEqual(['phase-1']);
    expect(one.w.steps[0]!.id).toBe('phase-1');
    const two = unpark(PW, [p, { ...p, id: 'plan' }], at);
    expect(two.ids).toEqual(['phase-1', 'phase-2']);
  });
  it('gives a max to a link that now points back', () => {
    const x = { ...mk('x'), links: [{ kind: 'next', to: 'plan' }] } as Step;
    const r = unpark(PW, [x], { branch: 'kids', index: PW.steps.length });
    expect(r.capped).toEqual(['`x` next → `plan`']);
    expect(flatSteps(r.w.steps).find((s) => s.id === 'x')!.links[0]!.max).toBe(3);
  });
  it('is the same workflow for an illegal place or no steps', () => {
    expect(unpark(PW, [mk('x')], { parent: 'nope', branch: 'kids', index: 0 })).toEqual({ w: PW, ids: [], capped: [] });
    expect(unpark(PW, [mk('x')], { parent: 'plan', branch: 'kids', index: 0 }).w).toBe(PW);
    expect(unpark(PW, [], at).w).toBe(PW);
  });
  it('never mutates its input', () => {
    const snap = JSON.stringify(PW), steps = [mk('plan')], s2 = JSON.stringify(steps);
    unpark(PW, steps, at);
    expect(JSON.stringify(PW)).toBe(snap);
    expect(JSON.stringify(steps)).toBe(s2);
  });
});

describe('stateBytes', () => {
  it('is the UTF-8 length of the JSON', () => {
    expect(stateBytes({ a: 'é' })).toBe(new TextEncoder().encode('{"a":"é"}').length);
    expect(stateBytes({})).toBe(2);
  });
});

describe('free blocks: the steps after the first top-level end', () => {
  const wf = (body: string) => parseWorkflow(`${HEAD}${body}`).workflow!;
  const ids = (l: Step[]) => l.map((s) => s.id);
  const base = wf('## phase plan\n\n## phase build\n');
  const withEnd = wf('## phase plan\n\n## end\n\n## phase fix\nnext: plan\n\n## phase other\n');
  it('splitAtEnd cuts at the first top-level end; a nested end does not cut', () => {
    const s = splitAtEnd(withEnd);
    expect([ids(s.stack), s.end?.id, ids(s.tail)]).toEqual([['plan'], 'end-1', ['fix', 'other']]);
    const none = splitAtEnd(base);
    expect([ids(none.stack), none.end, none.tail]).toEqual([['plan', 'build'], undefined, []]);
    const nested = wf('## phase a\n\n## repeat\nid: r\nuntil: tests pass\nmax: 3\n\n### end\n\n### phase z\n\n## phase b\n');
    expect([ids(splitAtEnd(nested).stack), splitAtEnd(nested).tail]).toEqual([['a', 'r', 'b'], []]);
  });
  it('freedBy names the free blocks that start to run when the top-level end is moved, parked or deleted', () => {
    expect(freedBy(withEnd, ['end-1'])).toEqual(['fix', 'other']);
    expect(freedBy(withEnd, ['plan', 'end-1'])).toEqual(['fix', 'other']);
    expect(freedBy(withEnd, ['plan', 'fix'])).toEqual([]);
    expect(freedBy(wf('## phase plan\n\n## end\n'), ['end-1'])).toEqual([]);
    expect(freedBy(base, ['plan'])).toEqual([]);
  });
  it('ensureEnd appends one end, once', () => {
    const m = ensureEnd(base);
    expect(m.steps.map((s) => s.kind)).toEqual(['phase', 'phase', 'end']);
    expect(ensureEnd(m)).toBe(m);
    expect(ensureEnd(withEnd)).toBe(withEnd);
  });
  it('detach moves a stack step behind the end and adds the end when missing', () => {
    const r = detach(base, 'plan')!;
    expect(r.w.steps.map((s) => s.id)).toEqual(['build', 'end-1', 'plan']);
    expect(r.capped).toEqual([]);
    expect(ids(splitAtEnd(detach(withEnd, 'plan')!.w).tail)).toEqual(['fix', 'other', 'plan']);
  });
  it('detach puts max 3 on a link that now points back, and says which', () => {
    const w = wf('## phase a\n\n## phase b\nnext: a\n\n## phase c\n');
    const r = detach(w, 'b')!;
    expect(r.capped).toEqual(['`b` next → `a`']);
    expect(r.w.steps.at(-1)!.links).toMatchObject([{ kind: 'next', to: 'a', max: 3 }]);
    expect(detach(wf('## phase a\n\n## phase b\nnext: c\n\n## phase c\n'), 'b')!.capped).toEqual(['`b` next → `c`']);
    expect(detach(wf('## phase a\n\n## phase b\n\n## phase c\n'), 'b')!.capped).toEqual([]);
  });
  it('detach refuses a nested step, a free step and the end', () => {
    const nested = wf('## repeat\nid: r\nuntil: tests pass\nmax: 3\n\n### phase z\n');
    expect(detach(nested, 'z')).toBeUndefined();
    expect(detach(withEnd, 'fix')).toBeUndefined();
    expect(detach(withEnd, 'end-1')).toBeUndefined();
    expect(detach(withEnd, 'nope')).toBeUndefined();
  });
  it('attach puts a free step back before the end, or at a slot', () => {
    expect(ids(attach(withEnd, 'fix')!.w.steps)).toEqual(['plan', 'fix', 'end-1', 'other']);
    expect(ids(attach(withEnd, 'other', { block: 'plan', edge: 'before' })!.w.steps)).toEqual(['other', 'plan', 'end-1', 'fix']);
  });
  it('attach caps a link that now points back; refuses a stack step', () => {
    const w = wf('## phase a\n\n## end\n\n## phase f\nnext: a\n');
    const r = attach(w, 'f')!;
    expect(r.capped).toEqual(['`f` next → `a`']);
    expect(attach(w, 'a')).toBeUndefined();
    expect(attach(base, 'plan')).toBeUndefined();
  });
  it('detach then attach brings the step back (the end stays)', () => {
    const r = detach(base, 'plan')!;
    expect(ids(attach(r.w, 'plan', { block: 'build', edge: 'before' })!.w.steps)).toEqual(['plan', 'build', 'end-1']);
  });
  it('pruneLayout drops free positions of steps that are no longer free; the same object when nothing goes', () => {
    const lay: Layout = { script: { x: 1, y: 1 }, free: { fix: { x: 5, y: 6 }, gone: { x: 7, y: 8 }, plan: { x: 9, y: 9 } } };
    const out = pruneLayout(lay, withEnd);
    expect(out).toEqual({ script: { x: 1, y: 1 }, free: { fix: { x: 5, y: 6 } } });
    expect(lay.free).toHaveProperty('gone');
    const ok: Layout = { free: { fix: { x: 5, y: 6 } } };
    expect(pruneLayout(ok, withEnd)).toBe(ok);
    expect(pruneLayout({ free: { gone: { x: 1, y: 1 } } }, withEnd)).toEqual({});
    expect(pruneLayout({}, withEnd)).toEqual({});
  });
  it('moveItems moves free positions by their s: key and leaves the others', () => {
    const lay: Layout = { free: { a: { x: 1, y: 2 }, b: { x: 10, y: 20 } } };
    expect(moveItems(lay, ['s:a'], { x: 5, y: 5 }).free).toEqual({ a: { x: 6, y: 7 }, b: { x: 10, y: 20 } });
    expect(lay.free!.a).toEqual({ x: 1, y: 2 });
    expect(moveItems({}, ['s:a'], { x: 5, y: 5 })).toEqual({});
  });
});