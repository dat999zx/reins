import { describe, it, expect } from 'vitest';
import { parseWorkflow } from '../src/format/parse.js';
import { printWorkflow } from '../src/format/print.js';
import { renameStep } from '../src/rename.js';
import type { Link, Step, Workflow } from '../src/model.js';

const runStep = (id: string, links: Link[] = []): Step => ({ id, kind: 'run', attrs: { cmd: 'npm test' }, cards: [], links });
const phase = (id: string, links: Link[] = [], attrs: Record<string, string> = {}): Step => ({
  id, kind: 'phase', title: id, attrs, cards: [], links, prompt: id,
});
const wf = (steps: Step[]): Workflow => ({
  version: 1, name: 'r', budget: { turns: 5, minutes: 5 }, always: [], steps, autos: [],
});
const reparse = (w: Workflow) => parseWorkflow(printWorkflow(w)).workflow!;
const strip = (x: unknown) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'pos' ? undefined : v)));

describe('printer default-id counter', () => {
  it('a custom id does not advance the counter, so the next default-id step keeps its id', () => {
    const w = wf([phase('a', [{ kind: 'next', to: 'run-2' }]), runStep('x'), runStep('run-2')]);
    const back = reparse(w);
    expect(back.steps.map((s) => s.id)).toEqual(['a', 'x', 'run-2']);
    expect(back.steps[0]!.links[0]!.to).toBe('run-2');
  });
});
describe('renameStep', () => {
  const build = () =>
    wf([
      phase('a', [{ kind: 'next', to: 'run-1' }, { kind: 'on-fail', to: 'run-1', max: 2 }]),
      runStep('run-1'),
      { id: 'rep', kind: 'repeat', attrs: { max: '2' }, cond: { t: 'tests' } as Step['cond'], cards: [], links: [], kids: [
        { id: 'v', kind: 'verify', attrs: { against: 'run-1' }, cards: [], links: [{ kind: 'next', to: 'run-1', max: 1 }] },
      ] },
      { id: 'iff', kind: 'if', attrs: {}, cond: { t: 'tests' } as Step['cond'], cards: [], links: [], kids: [phase('t')], else: [
        { id: 'v2', kind: 'verify', attrs: { against: 'run-1' }, cards: [], links: [{ kind: 'on-fail', to: 'run-1', max: 1 }] },
      ] },
      runStep('run-2'),
    ]);

  it('rewrites the id, every link and every against, at every depth, and the file round-trips', () => {
    const w = build();
    const r = renameStep(w, 'run-1', 'x');
    if ('error' in r) throw new Error(r.error);
    const out = r.workflow;
    expect(out.steps[1]!.id).toBe('x');
    expect(out.steps[0]!.links.map((l) => l.to)).toEqual(['x', 'x']);
    expect(out.steps[2]!.kids![0]!.attrs.against).toBe('x');
    expect(out.steps[2]!.kids![0]!.links[0]!.to).toBe('x');
    expect(out.steps[3]!.else![0]!.attrs.against).toBe('x');
    expect(out.steps[3]!.else![0]!.links[0]!.to).toBe('x');
    expect(JSON.stringify(out)).not.toContain('run-1');
    const text = printWorkflow(out);
    expect(text).toContain('id: x');
    expect(strip(parseWorkflow(text).workflow)).toEqual(strip(out));
  });

  it('round-trips with two default-id steps when the first is renamed', () => {
    const w = wf([phase('a', [{ kind: 'next', to: 'run-2' }]), runStep('run-1'), runStep('run-2')]);
    const r = renameStep(w, 'run-1', 'x');
    if ('error' in r) throw new Error(r.error);
    expect(strip(reparse(r.workflow))).toEqual(strip(r.workflow));
    expect(reparse(r.workflow).steps.map((s) => s.id)).toEqual(['a', 'x', 'run-2']);
  });

  it('errors on an unknown id, a taken id, and an invalid id', () => {
    const w = build();
    expect(renameStep(w, 'nope', 'y')).toHaveProperty('error');
    expect(renameStep(w, 'run-1', 'run-2')).toHaveProperty('error');
    for (const bad of ['', 'Has Caps', '-lead', 'trail-', 'a_b', 'a b']) {
      expect(renameStep(w, 'run-1', bad)).toHaveProperty('error');
    }
  });

  it('does not mutate its input', () => {
    const w = build();
    const before = JSON.stringify(w);
    renameStep(w, 'run-1', 'x');
    expect(JSON.stringify(w)).toBe(before);
  });
});