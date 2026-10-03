import { describe, expect, it } from 'vitest';
import { parseWorkflow, printWorkflow, type Diagnostic, type Workflow } from '@reins/core';
import { edgeId, editStep, flatSteps, marksOf, removeLinks, setLink, toGraph } from '../src/canvas.js';
import { layout } from '../src/layout.js';

const TEXT = `---
reins: 1
name: demo
budget: { turns: 10, minutes: 30 }
always: []
---

## phase plan
> Plan it.

## phase build
> Build it.

## repeat
id: r
until: tests pass
max: 3

### run \`npm test\`
id: t

### phase fix
> Fix it.

## if tests pass
id: i

### phase yes

### else

### phase no

## whenever drift
nudge: look up
`;

const parse = (text: string): Workflow => parseWorkflow(text).workflow!;
const lineOf = (text: string, needle: string) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;
const withPlanLink = (link: string) => TEXT.replace('## phase plan\n', `## phase plan\n${link}\n`);
const graph = (text: string, diags: Diagnostic[] = []) => {
  const w = parse(text);
  return toGraph(w, layout(w.steps), { conds: {}, diags, text });
};
const diag = (line: number, severity: 'error' | 'warning' = 'error'): Diagnostic => ({ severity, message: 'm', pos: { line, col: 1 } });

describe('toGraph nodes', () => {
  const { nodes } = graph(TEXT);
  const by = (id: string) => nodes.find((n) => n.id === id)!;
  it('puts every child after its parent', () => {
    for (const n of nodes) if (n.parentId) expect(nodes.findIndex((m) => m.id === n.parentId)).toBeLessThan(nodes.indexOf(n));
  });
  it('sets parents and types', () => {
    expect(by('t').parentId).toBe('r');
    expect(by('fix').parentId).toBe('r');
    expect(by('yes').parentId).toBe('i');
    expect(by('no').parentId).toBe('i');
    expect(by('plan').parentId).toBeUndefined();
    expect([by('r').type, by('i').type, by('plan').type, by('t').type]).toEqual(['group', 'group', 'step', 'step']);
    expect(by('t')).toMatchObject({ extent: 'parent', expandParent: true });
    expect(nodes.every((n) => n.deletable === false)).toBe(true);
  });
  it('marks the selected node', () => {
    const w = parse(TEXT);
    const g = toGraph(w, layout(w.steps), { conds: {}, diags: [], text: TEXT, selected: 'build' });
    expect(g.nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(['build']);
  });
});

describe('toGraph edges', () => {
  it('draws a next link and drops that step order edge', () => {
    const { edges } = graph(withPlanLink('next: fix'));
    expect(edges.map((e) => e.id)).toContain(edgeId('plan', 0, 'fix'));
    expect(edges.some((e) => e.source === 'plan' && e.data!.kind === 'order')).toBe(false);
    expect(edges.find((e) => e.id === 'plan>0>fix')).toMatchObject({ sourceHandle: 'next', targetHandle: 'in', deletable: true });
  });
  it('draws file order between siblings only', () => {
    const { edges } = graph(TEXT);
    const order = edges.filter((e) => e.data!.kind === 'order');
    expect(order.map((e) => e.id)).toContain('build>order>r');
    expect(order.some((e) => e.source === 'i')).toBe(false);
    expect(order.some((e) => e.source === 'fix')).toBe(false);
    expect(order.find((e) => e.id === 'build>order>r')).toMatchObject({ selectable: false, deletable: false, focusable: false });
  });
  it('skips a link to a missing id', () => {
    const { edges } = graph(withPlanLink('next: nowhere'));
    expect(edges.some((e) => e.target === 'nowhere')).toBe(false);
    expect(edges.some((e) => e.source === 'plan')).toBe(false);
  });
  it('uses the on-fail handle and keeps old kinds', () => {
    const t = TEXT.replace('id: t\n', 'id: t\non-fail: plan (max 2)\n');
    expect(graph(t).edges.find((e) => e.id === 't>0>plan')).toMatchObject({ sourceHandle: 'on-fail', data: { kind: 'on-fail', index: 0 } });
    const old = graph(withPlanLink('retry: build'));
    expect(old.edges.find((e) => e.id === 'plan>0>build')!.data!.kind).toBe('retry');
    expect(old.edges.find((e) => e.id === 'plan>0>build')!.sourceHandle).toBe('next');
  });
});

describe('setLink', () => {
  const w = parse(TEXT);
  const links = (x: Workflow, id: string) => flatSteps(x.steps).find((s) => s.id === id)!.links;
  it('adds a forward link without max', () => {
    expect(links(setLink(w, 'plan', 'next', 'build'), 'plan')).toStrictEqual([{ kind: 'next', to: 'build' }]);
  });
  it('replaces a link of the same kind', () => {
    const a = setLink(w, 'plan', 'next', 'build');
    expect(links(setLink(a, 'plan', 'next', 'fix'), 'plan')).toStrictEqual([{ kind: 'next', to: 'fix' }]);
  });
  it('keeps links of other kinds', () => {
    const a = setLink(parse(withPlanLink('retry: build')), 'plan', 'next', 'fix');
    expect(links(a, 'plan').map((l) => l.kind)).toEqual(['retry', 'next']);
  });
  it('adds max 3 to a backward link', () => {
    expect(links(setLink(w, 'fix', 'next', 'plan'), 'fix')).toStrictEqual([{ kind: 'next', to: 'plan', max: 3 }]);
  });
  it('ignores a self link', () => {
    expect(setLink(w, 'plan', 'next', 'plan')).toBe(w);
  });
  it('never mutates its input', () => {
    const before = structuredClone(w);
    setLink(w, 'plan', 'next', 'build');
    setLink(w, 'fix', 'on-fail', 'plan');
    removeLinks(w, [{ from: 'plan', index: 0 }]);
    editStep(w, 'plan', (s) => { s.title = 'x'; });
    expect(w).toEqual(before);
  });
  it('prints as next: under the heading', () => {
    expect(printWorkflow(setLink(w, 'plan', 'next', 'build'))).toContain('## phase plan\nnext: build');
  });
});

describe('removeLinks', () => {
  it('removes several refs on one step and keeps the rest in order', () => {
    const w = parse(TEXT.replace('## phase plan\n', '## phase plan\nnext: build\non-pass: fix\nretry: build\non-fail: fix (max 2)\n'));
    const out = removeLinks(w, [{ from: 'plan', index: 0 }, { from: 'plan', index: 2 }]);
    expect(flatSteps(out.steps).find((s) => s.id === 'plan')!.links.map((l) => l.kind)).toEqual(['on-pass', 'on-fail']);
  });
});

describe('editStep', () => {
  it('edits the clone and returns w for an unknown id', () => {
    const w = parse(TEXT);
    const out = editStep(w, 'fix', (s) => { s.title = 'changed'; });
    expect(flatSteps(out.steps).find((s) => s.id === 'fix')!.title).toBe('changed');
    expect(editStep(w, 'nope', () => { throw new Error('called'); })).toBe(w);
  });
});

describe('flatSteps', () => {
  it('walks in file order: step, kids, else', () => {
    expect(flatSteps(parse(TEXT).steps).map((s) => s.id)).toEqual(['plan', 'build', 'r', 't', 'fix', 'i', 'yes', 'no']);
  });
});

describe('diagnostic marks', () => {
  const text = withPlanLink('next: build');
  const node = (g: ReturnType<typeof graph>, id: string) => g.nodes.find((n) => n.id === id)!.data.mark;
  it('marks the step on its heading line', () => {
    const g = graph(text, [diag(lineOf(text, '## phase plan'))]);
    expect(node(g, 'plan')).toBe('error');
    expect(g.edges.find((e) => e.id === 'plan>0>build')!.data!.mark).toBeUndefined();
  });
  it('marks the edge, not the node, on a link line', () => {
    const g = graph(text, [diag(lineOf(text, 'next: build'), 'warning')]);
    expect(node(g, 'plan')).toBeUndefined();
    expect(g.edges.find((e) => e.id === 'plan>0>build')!.data!.mark).toBe('warning');
  });
  it('lets an error beat a warning', () => {
    const l = lineOf(text, '## phase plan');
    expect(node(graph(text, [diag(l, 'warning'), diag(l)]), 'plan')).toBe('error');
    expect(node(graph(text, [diag(l), diag(l, 'warning')]), 'plan')).toBe('error');
  });
  it('marks a line inside a step under that step', () => {
    expect(node(graph(text, [diag(lineOf(text, '> Build it.'))]), 'build')).toBe('error');
  });
  it('marks nothing for line 1, a whenever block or an else heading', () => {
    for (const line of [1, lineOf(text, '## whenever'), lineOf(text, 'nudge: look up'), lineOf(text, '### else')]) {
      const g = graph(text, [diag(line)]);
      expect(g.nodes.every((n) => n.data.mark === undefined), `line ${line}`).toBe(true);
      expect(g.edges.every((e) => e.data!.mark === undefined), `line ${line}`).toBe(true);
    }
  });
});

describe('marksOf', () => {
  const text = withPlanLink('next: build');
  const marks = (d: Diagnostic[]) => marksOf(parse(text), d, text);
  it('marks a step on its heading line', () => {
    const m = marks([diag(lineOf(text, '## phase plan'))]);
    expect(m.steps.get('plan')).toBe('error');
    expect(m.wires.size).toBe(0);
  });
  it('marks a wire, not the step, on a link line', () => {
    const m = marks([diag(lineOf(text, 'next: build'), 'warning')]);
    expect(m.wires.get('plan>0>build')).toBe('warning');
    expect(m.steps.size).toBe(0);
  });
  it('marks nothing at line 1', () => {
    const m = marks([diag(1)]);
    expect([m.steps.size, m.wires.size]).toEqual([0, 0]);
  });
});