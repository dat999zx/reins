import { describe, expect, it } from 'vitest';
import { parseWorkflow, printCond, printWorkflow, validate, type Workflow } from '@reins/core';
import { flatSteps } from '../src/canvas.js';
import { addPlace, addStep, addStepAt, stackEnd, capBackward, deleteStep, deleteSteps, dropPlace, dropSteps, duplicateSteps, insertSteps, moveStep, nestPlace, newId, placeOf, setAlways, setCond, takeSteps, withFreshIds } from '../src/blocks.js';

const HEAD = '---\nreins: 1\nname: demo\nbudget: { turns: 10, minutes: 30 }\nalways: []\n---\n\n';
const TEXT = `${HEAD}## phase plan
next: fix

## phase build

## repeat
id: r
until: tests pass
max: 3

### run \`npm test\`
id: t

### phase fix

## if tests pass
id: i

### phase yes

### else

### phase no

## verify
id: v
against: fix
`;

const parse = (text: string): Workflow => parseWorkflow(text).workflow!;
const w = parse(TEXT);
const ids = (list: Workflow['steps'] | undefined) => (list ?? []).map((s) => s.id);
const find = (m: Workflow, id: string) => flatSteps(m.steps).find((s) => s.id === id)!;

describe('placeOf', () => {
  it('finds top level, kids and else', () => {
    expect(placeOf(w, 'plan')).toEqual({ branch: 'kids', index: 0 });
    expect('parent' in placeOf(w, 'plan')!).toBe(false);
    expect(placeOf(w, 'fix')).toEqual({ parent: 'r', branch: 'kids', index: 1 });
    expect(placeOf(w, 'no')).toEqual({ parent: 'i', branch: 'else', index: 0 });
    expect(placeOf(w, 'nope')).toBeUndefined();
  });
});

describe('nestPlace', () => {
  it('in: after a container, at the end of its kids; otherwise nothing', () => {
    expect(nestPlace(w, 'i', 'in')).toEqual({ parent: 'r', branch: 'kids', index: 2 });
    expect(nestPlace(w, 'v', 'in')).toEqual({ parent: 'i', branch: 'kids', index: 1 });
    expect(nestPlace(w, 'r', 'in')).toBeUndefined();
    expect(nestPlace(w, 'plan', 'in')).toBeUndefined();
    expect(nestPlace(w, 'fix', 'in')).toBeUndefined();
    expect(nestPlace(w, 'nope', 'in')).toBeUndefined();
  });
  it('out: right after the parent; top level has nowhere to go', () => {
    expect(nestPlace(w, 'fix', 'out')).toEqual({ branch: 'kids', index: 3 });
    expect(nestPlace(w, 'no', 'out')).toEqual({ branch: 'kids', index: 4 });
    expect(nestPlace(w, 'plan', 'out')).toBeUndefined();
  });
  it('results move cleanly and survive print and parse', () => {
    for (const [id, dir] of [['i', 'in'], ['v', 'in'], ['fix', 'out'], ['no', 'out']] as const) {
      const to = nestPlace(w, id, dir)!;
      const m = moveStep(w, id, to);
      expect(m, `${id} ${dir}`).not.toBe(w);
      expect(placeOf(m, id)).toEqual(to);
      const text = printWorkflow(m);
      const r = parseWorkflow(text);
      expect(r.diagnostics).toEqual([]);
      expect(printWorkflow(r.workflow!)).toBe(text);
    }
  });
});

describe('moveStep', () => {
  it('moves within a list; slot = own place is a no-op', () => {
    expect(ids(moveStep(w, 'build', { branch: 'kids', index: 0 }).steps).slice(0, 2)).toEqual(['build', 'plan']);
    expect(ids(moveStep(w, 'plan', { branch: 'kids', index: 2 }).steps).slice(0, 2)).toEqual(['build', 'plan']);
    expect(moveStep(w, 'plan', { branch: 'kids', index: 0 })).toBe(w);
    expect(moveStep(w, 'plan', { branch: 'kids', index: 1 })).toBe(w);
  });
  it('moves into containers, creating else', () => {
    expect(ids(find(moveStep(w, 'build', { parent: 'r', branch: 'kids', index: 0 }), 'r').kids)).toEqual(['build', 't', 'fix']);
    expect(ids(find(moveStep(w, 'build', { parent: 'i', branch: 'else', index: 1 }), 'i').else)).toEqual(['no', 'build']);
    const noElse = parse(`${HEAD}## phase a\n\n## if tests pass\nid: i2\n\n### phase y\n`);
    expect(ids(find(moveStep(noElse, 'a', { parent: 'i2', branch: 'else', index: 0 }), 'i2').else)).toEqual(['a']);
  });
  it('is a no-op for invalid targets', () => {
    for (const [id, to] of [
      ['r', { parent: 'r', branch: 'kids', index: 0 }],
      ['r', { parent: 't', branch: 'kids', index: 0 }],
      ['plan', { parent: 'build', branch: 'kids', index: 0 }],
      ['plan', { parent: 'plan', branch: 'kids', index: 0 }],
      ['build', { parent: 'r', branch: 'else', index: 0 }],
      ['build', { branch: 'else', index: 0 }],
      ['nope', { branch: 'kids', index: 0 }],
      ['build', { parent: 'nope', branch: 'kids', index: 0 }],
    ] as const) expect(moveStep(w, id, to), `${id} -> ${JSON.stringify(to)}`).toBe(w);
    const deep = parse(`${HEAD}## repeat\nid: a\nuntil: tests pass\nmax: 3\n\n### repeat\nid: b\nuntil: tests pass\nmax: 3\n\n#### phase c\n`);
    expect(moveStep(deep, 'a', { parent: 'c', branch: 'kids', index: 0 })).toBe(deep);
    expect(moveStep(deep, 'a', { parent: 'b', branch: 'kids', index: 0 })).toBe(deep);
  });
  it('can empty a container and still print and parse', () => {
    let m = moveStep(w, 't', { branch: 'kids', index: 0 });
    m = moveStep(m, 'fix', { branch: 'kids', index: 0 });
    const back = parseWorkflow(printWorkflow(m));
    expect(back.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(find(back.workflow!, 'r').kids ?? []).toEqual([]);
  });
  it('keeps ids and links when a counter default shifts', () => {
    const two = parse(`${HEAD}## run \`a\`\n\n## run \`b\`\n\n## phase z\nnext: run-2\n`);
    expect(ids(two.steps)).toEqual(['run-1', 'run-2', 'z']);
    const moved = moveStep(two, 'run-2', { branch: 'kids', index: 0 });
    const text = printWorkflow(moved);
    expect(text).toContain('id: run-2');
    const back = parse(text);
    expect(ids(back.steps)).toEqual(['run-2', 'run-1', 'z']);
    // the link still resolves; the only error is the backward-link rule (validate.ts:209), which a move may cause
    expect(validate(back).filter((d) => d.severity === 'error').map((d) => d.message)).toEqual(['Backward link to "run-2" requires max']);
  });
});

describe('newId', () => {
  it('takes the first free number', () => {
    expect(newId(w, 'phase')).toBe('phase-1');
  });
  it('counts step ids at every depth, link targets and against values', () => {
    expect(newId(parse(`${HEAD}## phase phase-1\n`), 'phase')).toBe('phase-2');
    expect(newId(parse(`${HEAD}## repeat\nuntil: tests pass\nmax: 3\n\n### phase phase-1\n`), 'phase')).toBe('phase-2');
    expect(newId(parse(`${HEAD}## if tests pass\n\n### phase y\n\n### else\n\n### phase phase-1\n`), 'phase')).toBe('phase-2');
    expect(newId(parse(`${HEAD}## phase a\nnext: phase-1\n`), 'phase')).toBe('phase-2');
    expect(newId(parse(`${HEAD}## verify\nagainst: phase-1\n`), 'phase')).toBe('phase-2');
  });
});

describe('addStep', () => {
  it('inserts after a step, in its own list, or at the end', () => {
    const id = newId(w, 'phase');
    expect(ids(addStep(w, 'phase', 'build').steps)).toEqual(['plan', 'build', id, 'r', 'i', 'v']);
    expect(ids(find(addStep(w, 'phase', 'fix'), 'r').kids)).toEqual(['t', 'fix', id]);
    expect(ids(addStep(w, 'phase').steps)).toEqual(['plan', 'build', 'r', 'i', 'v', id]);
    expect(ids(addStep(w, 'phase', 'nope').steps).at(-1)).toBe(id);
  });
  it('does nothing for a kind with no fresh', () => {
    expect(addStep(w, 'use')).toBe(w);
  });
  it('add then delete gives the same bytes', () => {
    expect(printWorkflow(deleteStep(addStep(w, 'phase', 'build'), newId(w, 'phase')))).toBe(printWorkflow(w));
  });
});

describe('addStepAt', () => {
  const id = newId(w, 'phase');
  it('inserts at an explicit place, clamping the index', () => {
    expect(ids(find(addStepAt(w, 'phase', { parent: 'r', branch: 'kids', index: 0 }), 'r').kids)).toEqual([id, 't', 'fix']);
    expect(ids(find(addStepAt(w, 'phase', { parent: 'r', branch: 'kids', index: 2 }), 'r').kids)).toEqual(['t', 'fix', id]);
    expect(ids(find(addStepAt(w, 'phase', { parent: 'r', branch: 'kids', index: 99 }), 'r').kids)).toEqual(['t', 'fix', id]);
    expect(ids(find(addStepAt(w, 'phase', { parent: 'i', branch: 'else', index: 0 }), 'i').else)).toEqual([id, 'no']);
    expect(ids(addStepAt(w, 'phase', { branch: 'kids', index: 0 }).steps)).toEqual([id, 'plan', 'build', 'r', 'i', 'v']);
    expect(ids(addStepAt(w, 'phase', { branch: 'kids', index: -3 }).steps)[0]).toBe(id);
  });
  it('creates an else list that is not there yet', () => {
    const noElse = parse(`${HEAD}## if tests pass\nid: i2\n\n### phase y\n`);
    expect(ids(find(addStepAt(noElse, 'phase', { parent: 'i2', branch: 'else', index: 0 }), 'i2').else)).toEqual(['phase-1']);
  });
  it('does nothing for a place with no list, or a kind with no fresh', () => {
    expect(addStepAt(w, 'phase', { parent: 'plan', branch: 'kids', index: 0 })).toBe(w);
    expect(addStepAt(w, 'phase', { parent: 'nope', branch: 'kids', index: 0 })).toBe(w);
    expect(addStepAt(w, 'phase', { parent: 'r', branch: 'else', index: 0 })).toBe(w);
    expect(addStepAt(w, 'phase', { branch: 'else', index: 0 })).toBe(w);
    expect(addStepAt(w, 'use', { branch: 'kids', index: 0 })).toBe(w);
  });
  it('never mutates its input', () => {
    const before = structuredClone(w);
    addStepAt(w, 'phase', { parent: 'i', branch: 'else', index: 0 });
    expect(w).toEqual(before);
  });
});

describe('dropPlace', () => {
  it('before / after a block is its slot / slot + 1, in its own list', () => {
    expect(dropPlace(w, { block: 'build', edge: 'before' })).toEqual({ branch: 'kids', index: 1 });
    expect(dropPlace(w, { block: 'build', edge: 'after' })).toEqual({ branch: 'kids', index: 2 });
    expect(dropPlace(w, { block: 'fix', edge: 'before' })).toEqual({ parent: 'r', branch: 'kids', index: 1 });
    expect(dropPlace(w, { block: 'fix', edge: 'after' })).toEqual({ parent: 'r', branch: 'kids', index: 2 });
    expect(dropPlace(w, { block: 'no', edge: 'after' })).toEqual({ parent: 'i', branch: 'else', index: 1 });
  });
  it('into and else are first in that body, only where the block has it', () => {
    expect(dropPlace(w, { block: 'r', edge: 'into' })).toEqual({ parent: 'r', branch: 'kids', index: 0 });
    expect(dropPlace(w, { block: 'i', edge: 'into' })).toEqual({ parent: 'i', branch: 'kids', index: 0 });
    expect(dropPlace(w, { block: 'i', edge: 'else' })).toEqual({ parent: 'i', branch: 'else', index: 0 });
    expect(dropPlace(w, { block: 'plan', edge: 'into' })).toBeUndefined();
    expect(dropPlace(w, { block: 'plan', edge: 'else' })).toBeUndefined();
    expect(dropPlace(w, { block: 'r', edge: 'else' })).toBeUndefined();
  });
  it('the script start and end, and a body', () => {
    expect(dropPlace(w, { top: 'start' })).toEqual({ branch: 'kids', index: 0 });
    expect(dropPlace(w, { top: 'end' })).toEqual({ branch: 'kids', index: 5 });
    expect(dropPlace(w, { body: 'r', branch: 'kids' })).toEqual({ parent: 'r', branch: 'kids', index: 0 });
    expect(dropPlace(w, { body: 'i', branch: 'else' })).toEqual({ parent: 'i', branch: 'else', index: 0 });
    expect(dropPlace(w, { body: 'r', branch: 'else' })).toBeUndefined();
  });
  it('an unknown block gives nothing', () => {
    expect(dropPlace(w, { block: 'nope', edge: 'before' })).toBeUndefined();
    expect(dropPlace(w, { block: 'nope', edge: 'into' })).toBeUndefined();
    expect(dropPlace(w, { body: 'nope', branch: 'kids' })).toBeUndefined();
  });
  it('never mutates its input', () => {
    const before = structuredClone(w);
    dropPlace(w, { body: 'i', branch: 'else' });
    expect(w).toEqual(before);
  });
});

describe('deleteStep', () => {
  it('removes the subtree, links into it and against', () => {
    const m = deleteStep(w, 'r');
    expect(ids(flatSteps(m.steps))).toEqual(['plan', 'build', 'i', 'yes', 'no', 'v']);
    expect(find(m, 'plan').links).toEqual([]);
    expect('against' in find(m, 'v').attrs).toBe(false);
    expect(find(m, 'build')).toEqual(find(w, 'build'));
  });
  it('keeps links to steps that stay', () => {
    expect(find(deleteStep(w, 'build'), 'plan').links.map((l) => l.to)).toEqual(['fix']);
    expect(find(deleteStep(w, 'build'), 'v').attrs.against).toBe('fix');
  });
  it('does nothing for an unknown id', () => {
    expect(deleteStep(w, 'nope')).toBe(w);
  });
});

describe('setAlways', () => {
  it('trims lines and drops blanks', () => {
    expect(setAlways(w, ' a \n\n b\n').always).toEqual(['a', 'b']);
  });
});

describe('setCond', () => {
  const cw = parse(`${TEXT}\n## gate\nid: g\nuntil: tests pass and not attempts > 3\n`);
  const condOf = (m: Workflow) => find(m, 'g').cond!;
  const printed = (m: Workflow) => printCond(condOf(m));
  const check = (m: Workflow) => {
    const r = parseWorkflow(printWorkflow(m));
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  };
  it('replaces the node at a path', () => {
    const a = setCond(cw, 'g', [], { t: 'approve' });
    expect(printed(a)).toBe('you approve');
    const b = setCond(cw, 'g', ['a'], { t: 'approve' });
    expect(printed(b)).toBe('you approve and not attempts > 3');
    const c = setCond(cw, 'g', ['b', 'a'], { t: 'attempts', n: 5 });
    expect(printed(c)).toBe('tests pass and not attempts > 5');
    for (const m of [a, b, c]) check(m);
  });
  it('sets a condition on a block whose condition was deleted', () => {
    const bare = parse(`${TEXT}\n## repeat\nid: rr\nuntil: tests pass\nmax: 3\n`);
    const noCond = structuredClone(bare);
    delete find(noCond, 'rr').cond;
    const m = setCond(noCond, 'rr', [], { t: 'approve' });
    expect(printCond(find(m, 'rr').cond!)).toBe('you approve');
    expect(parseWorkflow(printWorkflow(m)).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
  it('does nothing for a path that is not there, a step with no condition slot, or an unknown id', () => {
    expect(setCond(cw, 'g', ['b', 'b'], { t: 'approve' })).toBe(cw);
    expect(setCond(cw, 'g', ['a', 'a'], { t: 'approve' })).toBe(cw);
    expect(setCond(cw, 'plan', [], { t: 'approve' })).toBe(cw);
    expect(setCond(cw, 'nope', [], { t: 'approve' })).toBe(cw);
  });
  it('never mutates its input', () => {
    const before = structuredClone(cw);
    setCond(cw, 'g', ['b', 'a'], { t: 'approve' });
    expect(cw).toEqual(before);
  });
});

describe('duplicate parent ids', () => {
  const dup = parseWorkflow(
    ['---', 'reins: 1', 'name: t', 'budget: { turns: 1, minutes: 1 }', 'always: []', '---', '',
      '## phase a', 'id: r', '> a', '', '## repeat r', 'id: r', 'max: 3', 'until: you approve', '', '### say x', '> x', ''].join('\n'),
  ).workflow!;
  it('does nothing instead of throwing or editing the wrong list', () => {
    expect(deleteStep(dup, 'x')).toBe(dup);
    expect(moveStep(dup, 'x', { branch: 'kids', index: 0 })).toBe(dup);
  });
});

describe('purity', () => {
  it('never mutates its input', () => {
    const before = structuredClone(w);
    moveStep(w, 'build', { parent: 'r', branch: 'kids', index: 0 });
    moveStep(w, 'fix', { branch: 'kids', index: 0 });
    addStep(w, 'repeat', 'fix');
    deleteStep(w, 'r');
    setAlways(w, 'x');
    newId(w, 'phase');
    placeOf(w, 'fix');
    expect(w).toEqual(before);
  });
});

describe('insertSteps', () => {
  const mk = (id: string) => ({ id, kind: 'phase', attrs: {}, cards: [], links: [] }) as unknown as Workflow['steps'][number];
  it('inserts the given steps, in order, at a place', () => {
    expect(ids(insertSteps(w, [mk('a'), mk('b')], { branch: 'kids', index: 1 }).steps)).toEqual(['plan', 'a', 'b', 'build', 'r', 'i', 'v']);
    expect(ids(find(insertSteps(w, [mk('a')], { parent: 'r', branch: 'kids', index: 0 }), 'r').kids)).toEqual(['a', 't', 'fix']);
  });
  it('gives the same workflow for a place that does not exist', () => {
    expect(insertSteps(w, [mk('a')], { parent: 'plan', branch: 'kids', index: 0 })).toBe(w);
    expect(insertSteps(w, [mk('a')], { parent: 'r', branch: 'else', index: 0 })).toBe(w);
  });
});

describe('takeSteps', () => {
  it('removes the steps and returns them in document order', () => {
    const r = takeSteps(w, ['fix', 'plan']);
    expect(ids(r.taken)).toEqual(['plan', 'fix']);
    expect(flatSteps(r.w.steps).map((s) => s.id)).not.toContain('plan');
    expect(flatSteps(r.w.steps).map((s) => s.id)).not.toContain('fix');
  });
  it('takes a container with its subtree, and not its selected child twice', () => {
    const r = takeSteps(w, ['fix', 'r']);
    expect(ids(r.taken)).toEqual(['r']);
    expect(ids(r.taken[0]!.kids)).toEqual(['t', 'fix']);
  });
  it('keeps links: the steps are moving, not going away', () => {
    expect(takeSteps(w, ['fix']).w.steps[0]!.links).toEqual(w.steps[0]!.links);
  });
});

describe('dropSteps', () => {
  const order = (m: Workflow) => ids(m.steps);
  it('moves two top-level steps before plan, in document order', () => {
    expect(order(dropSteps(w, ['v', 'build'], { block: 'plan', edge: 'before' }))).toEqual(['build', 'v', 'plan', 'r', 'i']);
  });
  it('moves several steps into the kids of r', () => {
    const m = dropSteps(w, ['plan', 'build'], { body: 'r', branch: 'kids' });
    expect(ids(find(m, 'r').kids)).toEqual(['plan', 'build', 't', 'fix']);
  });
  it('is the same workflow when the drop is on a moved step, inside one, or changes nothing', () => {
    expect(dropSteps(w, ['plan', 'build'], { block: 'build', edge: 'before' })).toBe(w);
    expect(dropSteps(w, ['r'], { block: 'fix', edge: 'before' })).toBe(w);
    expect(dropSteps(w, ['r'], { body: 'r', branch: 'kids' })).toBe(w);
    expect(dropSteps(w, ['plan'], { block: 'build', edge: 'before' })).toBe(w);
    expect(dropSteps(w, ['nope'], { top: 'start' })).toBe(w);
  });
  it('equals moveStep for one id', () => {
    const hits = [{ block: 'v', edge: 'after' }, { top: 'start' }, { top: 'end' }, { body: 'i', branch: 'else' }, { block: 'r', edge: 'into' }, { block: 'plan', edge: 'after' }] as const;
    for (const id of ['build', 'fix', 'plan', 'no']) for (const hit of hits) {
      const place = dropPlace(w, hit);
      const want = place ? moveStep(w, id, place) : w;
      expect(printWorkflow(dropSteps(w, [id], hit))).toBe(printWorkflow(want));
    }
  });
  it('prints and parses', () => {
    const m = dropSteps(w, ['v', 'fix'], { block: 'plan', edge: 'before' });
    expect(parseWorkflow(printWorkflow(m)).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('deleteSteps', () => {
  it('deletes several, with the links and against that pointed at them', () => {
    const m = deleteSteps(w, ['plan', 'fix']);
    expect(ids(m.steps)).not.toContain('plan');
    expect(find(m, 'v').attrs.against).toBeUndefined();
    expect(parseWorkflow(printWorkflow(m)).workflow).toBeDefined();
  });
  it('handles a parent and its child in one call; unknown ids change nothing', () => {
    expect(flatSteps(deleteSteps(w, ['fix', 'r']).steps).map((s) => s.id)).toEqual(['plan', 'build', 'i', 'yes', 'no', 'v']);
    expect(deleteSteps(w, ['nope'])).toBe(w);
    expect(deleteSteps(w, [])).toBe(w);
  });
});

describe('capBackward', () => {
  const after = (): Workflow => moveStep(w, 'plan', { parent: 'r', branch: 'kids', index: 2 });
  it('gives a link that now points back a max of 3 and names it', () => {
    const r = capBackward(after());
    expect(find(r.w, 'plan').links).toMatchObject([{ kind: 'next', to: 'fix', max: 3 }]);
    expect(r.capped).toEqual(['`plan` next → `fix`']);
  });
  it('keeps an existing max, and leaves forward links alone', () => {
    const m = after();
    find(m, 'plan').links[0]!.max = 7;
    const r = capBackward(m);
    expect(r.w).toBe(m);
    expect(r.capped).toEqual([]);
    expect(capBackward(w).w).toBe(w);
  });
  it('caps a link to itself, and prints and parses', () => {
    const m = structuredClone(w);
    find(m, 'build').links.push({ kind: 'on-fail', to: 'build' });
    const r = capBackward(m);
    expect(find(r.w, 'build').links[0]!.max).toBe(3);
    expect(parseWorkflow(printWorkflow(r.w)).workflow).toBeDefined();
  });
  it('never mutates its input', () => {
    const m = after(), before = structuredClone(m);
    capBackward(m);
    expect(m).toEqual(before);
  });
});

describe('purity of the multi-step functions', () => {
  it('never mutates its input', () => {
    const before = structuredClone(w);
    takeSteps(w, ['plan', 'r']);
    dropSteps(w, ['v', 'build'], { block: 'plan', edge: 'before' });
    deleteSteps(w, ['plan', 'r']);
    insertSteps(w, [w.steps[0]!], { branch: 'kids', index: 0 });
    expect(w).toEqual(before);
  });
});

const S = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'phase', attrs: {}, cards: [], links: [], ...extra }) as Workflow['steps'][number];

describe('withFreshIds', () => {
  it('keeps an id that is free, renames one that is taken', () => {
    expect(withFreshIds(w, [S('mine')]).map((s) => s.id)).toEqual(['mine']);
    expect(withFreshIds(w, [S('plan')]).map((s) => s.id)).toEqual(['phase-1']);
  });
  it('two taken ids in one call get two different new ids', () => {
    expect(withFreshIds(w, [S('plan'), S('build')]).map((s) => s.id)).toEqual(['phase-1', 'phase-2']);
  });
  it('the same id twice in one call gives two different ids, taken or free', () => {
    expect(withFreshIds(w, [S('plan'), S('plan')]).map((s) => s.id)).toEqual(['phase-1', 'phase-2']);
    expect(withFreshIds(w, [S('mine'), S('mine')]).map((s) => s.id)).toEqual(['mine', 'phase-1']);
  });
  it('a renamed id does not meet an id the call keeps', () => {
    expect(withFreshIds(w, [S('phase-1'), S('plan')]).map((s) => s.id)).toEqual(['phase-1', 'phase-2']);
  });
  it('avoids ids that only a link or an against points at', () => {
    const m = structuredClone(w);
    find(m, 'plan').links = [{ kind: 'next', to: 'ghost' }];
    find(m, 'v').attrs.against = 'phantom';
    expect(withFreshIds(m, [S('ghost'), S('phantom')]).map((s) => s.id)).toEqual(['phase-1', 'phase-2']);
  });
  it('links and against inside the call follow a rename; links outside stay', () => {
    const [a, b] = withFreshIds(w, [S('plan', { links: [{ kind: 'next', to: 'build' }, { kind: 'on-fail', to: 'fix' }] }), S('build', { attrs: { against: 'plan' } })]) as [Workflow['steps'][number], Workflow['steps'][number]];
    expect([a.id, b.id]).toEqual(['phase-1', 'phase-2']);
    expect(a.links.map((l) => l.to)).toEqual(['phase-2', 'fix']);
    expect(b.attrs.against).toBe('phase-1');
  });
  it('renames inside a C block and follows links between its kids', () => {
    const [c] = withFreshIds(w, [S('r', { kind: 'repeat', kids: [S('t', { links: [{ kind: 'next', to: 'fix' }] }), S('fix')] })]);
    expect(c!.id).toBe('repeat-1');
    expect(c!.kids!.map((k) => k.id)).toEqual(['phase-1', 'phase-2']); // t and fix are both taken by the workflow
    expect(c!.kids![0]!.links[0]!.to).toBe('phase-2');
  });
  it('never mutates its input', () => {
    const input = [S('plan', { links: [{ kind: 'next', to: 'build' }] }), S('build')], snap = structuredClone(input), before = structuredClone(w);
    withFreshIds(w, input);
    expect(input).toEqual(snap);
    expect(w).toEqual(before);
  });
});

describe('duplicateSteps', () => {
  it('puts a copy with a fresh id right after the original and returns the new id', () => {
    const r = duplicateSteps(w, ['build']);
    expect(ids(r.w.steps).slice(0, 4)).toEqual(['plan', 'build', 'phase-1', 'r']);
    expect(r.ids).toEqual(['phase-1']);
  });
  it('keeps a link to a step outside the copy', () => {
    const r = duplicateSteps(w, ['plan']);
    expect(find(r.w, 'phase-1').links).toMatchObject([{ kind: 'next', to: 'fix' }]);
  });
  it('several steps, each copy after its own original', () => {
    const r = duplicateSteps(w, ['plan', 'build']);
    expect(ids(r.w.steps).slice(0, 4)).toEqual(['plan', 'phase-1', 'build', 'phase-2']);
    expect(r.ids).toEqual(['phase-1', 'phase-2']);
  });
  it('a C block is copied with its kids, links inside follow the new ids', () => {
    const r = duplicateSteps(w, ['plan', 'r']);
    expect(r.ids).toHaveLength(2);
    const copy = find(r.w, r.ids[1]!);
    expect(copy.kind).toBe('repeat');
    expect(ids(copy.kids)).toHaveLength(2);
    expect(ids(copy.kids).some((k) => k === 't' || k === 'fix')).toBe(false);
    expect(find(r.w, r.ids[0]!).links[0]!.to).toBe(ids(copy.kids)[1]); // plan -> fix became plan' -> fix'
  });
  it('a step inside a selected C block is not copied twice', () => {
    const r = duplicateSteps(w, ['r', 'fix']);
    expect(r.ids).toHaveLength(1);
  });
  it('an unknown id changes nothing', () => {
    const r = duplicateSteps(w, ['nope']);
    expect(r.w).toBe(w);
    expect(r.ids).toEqual([]);
  });
  it('prints and parses, and never mutates', () => {
    const before = structuredClone(w);
    const r = duplicateSteps(w, ['plan', 'r', 'i']);
    expect(w).toEqual(before);
    const text = printWorkflow(r.w);
    const back = parseWorkflow(text);
    expect(back.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(printWorkflow(back.workflow!)).toBe(text);
  });
});
describe('the end of the stack', () => {
  const wf = parseWorkflow(`${HEAD}## phase a\n\n## phase b\n\n## end\n\n## phase f\n`).workflow!;
  const ids = (w: Workflow) => w.steps.map((s) => s.id);
  it('stackEnd is the first top-level end, else the length', () => {
    expect(stackEnd(wf)).toBe(2);
    expect(stackEnd({ ...wf, steps: wf.steps.slice(0, 2) })).toBe(2);
    expect(stackEnd({ ...wf, steps: [] })).toBe(0);
  });
  it('addPlace: after a stack step goes after it; anything else lands before the end', () => {
    expect(addPlace(wf, 'a')).toEqual({ branch: 'kids', index: 1 });
    expect(addPlace(wf)).toEqual({ branch: 'kids', index: 2 });
    expect(addPlace(wf, 'end-1')).toEqual({ branch: 'kids', index: 2 });
    expect(addPlace(wf, 'f')).toEqual({ branch: 'kids', index: 2 });
    expect(addPlace(wf, 'nope')).toEqual({ branch: 'kids', index: 2 });
  });
  it('addStep never adds after the end', () => {
    for (const after of [undefined, 'b', 'end-1', 'f']) {
      const m = addStep(wf, 'phase', after);
      expect(ids(m).indexOf('end-1')).toBeGreaterThan(ids(m).indexOf('phase-1'));
    }
  });
  it('a drop on the end strip lands before the end', () => {
    expect(dropPlace(wf, { top: 'end' })).toEqual({ branch: 'kids', index: 2 });
    expect(ids(dropSteps(wf, ['a'], { top: 'end' }))).toEqual(['b', 'a', 'end-1', 'f']);
  });
});