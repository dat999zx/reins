import { describe, expect, it } from 'vitest';
import { parseWorkflow, printWorkflow, type Step } from '@reins/core';
import { addLoose, HOME, LOOSE_MAX, moveItems, nextKey, removeLoose, selfContained, stateBytes } from '../src/arrange.js';
import type { Layout } from '../src/editorState.js';

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

describe('stateBytes', () => {
  it('is the UTF-8 length of the JSON', () => {
    expect(stateBytes({ a: 'é' })).toBe(new TextEncoder().encode('{"a":"é"}').length);
    expect(stateBytes({})).toBe(2);
  });
});
