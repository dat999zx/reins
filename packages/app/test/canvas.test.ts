import { describe, expect, it } from 'vitest';
import { parseWorkflow, printWorkflow, type Diagnostic, type Workflow } from '@reins/core';
import { editStep, flatSteps, marksOf, removeLinks, setLink } from '../src/canvas.js';

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
const diag = (line: number, severity: 'error' | 'warning' = 'error'): Diagnostic => ({ severity, message: 'm', pos: { line, col: 1 } });

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
  it('lets an error beat a warning', () => {
    const l = lineOf(text, '## phase plan');
    expect(marks([diag(l, 'warning'), diag(l)]).steps.get('plan')).toBe('error');
    expect(marks([diag(l), diag(l, 'warning')]).steps.get('plan')).toBe('error');
  });
  it('marks a line inside a step under that step', () => {
    expect(marks([diag(lineOf(text, '> Build it.'))]).steps.get('build')).toBe('error');
  });
  it('marks nothing for line 1, a whenever block or an else heading', () => {
    for (const line of [1, lineOf(text, '## whenever'), lineOf(text, 'nudge: look up'), lineOf(text, '### else')]) {
      const m = marks([diag(line)]);
      expect([m.steps.size, m.wires.size], `line ${line}`).toEqual([0, 0]);
    }
  });
});