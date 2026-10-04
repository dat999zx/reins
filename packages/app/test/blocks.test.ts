import { describe, expect, it } from 'vitest';
import { parseWorkflow, printCond, printWorkflow, validate, type Workflow } from '@reins/core';
import { flatSteps } from '../src/canvas.js';
import { addStep, deleteStep, moveStep, nestPlace, newId, placeOf, setAlways, setCond } from '../src/blocks.js';

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
