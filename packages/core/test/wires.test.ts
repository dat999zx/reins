import { describe, it, expect } from 'vitest';
import { Run } from '../src/run.js';
import { FakeEngine } from '../src/fake-engine.js';
import { parseWorkflow } from '../src/format/parse.js';
import { printWorkflow } from '../src/format/print.js';
import { validate } from '../src/validate.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Link, Step, Workflow } from '../src/model.js';

const phase = (id: string, links: Link[] = []): Step => ({
  id,
  kind: 'phase',
  title: id,
  attrs: {},
  cards: [],
  links,
  prompt: id,
});
const runStep = (id: string, cmd: string, links: Link[] = []): Step => ({
  id,
  kind: 'run',
  attrs: { cmd },
  cards: [],
  links,
});
const wf = (steps: Step[]): Workflow => ({
  version: 1,
  name: 'wires',
  budget: { turns: 50, minutes: 50 },
  always: [],
  steps,
  autos: [],
});
const DONE = { text: 'ok\nREINS: done' };
const FAIL = { text: 'REINS: fail: nope' };
const turns = (run: Run) =>
  run.getEvents().filter((e) => e.type === 'turn_started').map((e) => e.data.step as string);
const drain = async (run: Run) => {
  while (run.status === 'running') await run.step();
};

describe('Task 1: link budget pause resumes at the interrupted jump', () => {
  it('allowMore after a verify link pause re-runs the jump target, not the verify', async () => {
    const w = wf([
      phase('implement'),
      { id: 'verify-1', kind: 'verify', attrs: { against: 'implement' }, cards: [], links: [{ kind: 'on-fail', to: 'implement', max: 1 }] },
    ]);
    const engine = new FakeEngine([DONE, FAIL, DONE, FAIL, DONE, FAIL, DONE, FAIL]);
    const run = new Run({ workflow: w, engine });
    await drain(run);
    expect(run.pauseReason?.type).toBe('link-budget-used');
    expect(turns(run)).toEqual(['implement', 'verify-1', 'implement', 'verify-1']);

    run.allowMore(2);
    await drain(run);
    expect(turns(run).slice(4)).toEqual(['implement', 'verify-1', 'implement', 'verify-1']);
    expect(run.status).toBe('paused');
    expect(run.pauseReason?.type).toBe('link-budget-used');
  });
});

describe('Task 2: next is a real jump', () => {
  it('skips the steps in between', async () => {
    const run = new Run({
      workflow: wf([phase('a', [{ kind: 'next', to: 'c' }]), phase('b'), phase('c')]),
      engine: new FakeEngine([DONE, DONE, DONE]),
    });
    await drain(run);
    expect(run.status).toBe('done');
    expect(turns(run)).toEqual(['a', 'c']);
  });

  it('a next on a repeat jumps once, after the loop is done', async () => {
    const rep: Step = {
      id: 'rep',
      kind: 'repeat',
      cond: { t: 'cmd', cmd: 'npm test' },
      attrs: { max: '3' },
      cards: [],
      links: [{ kind: 'next', to: 'after' }],
      kids: [phase('body')],
    };
    const run = new Run({
      workflow: wf([rep, phase('skipped'), phase('after')]),
      engine: new FakeEngine([DONE, DONE, DONE]),
      commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });
    await drain(run);
    expect(run.status).toBe('done');
    expect(turns(run)).toEqual(['body', 'after']);
  });

  it('a backward next with a budget pauses when the JUMP is reached a second time', async () => {
    const run = new Run({
      workflow: wf([phase('a'), phase('b'), phase('c', [{ kind: 'next', to: 'a', max: 1 }])]),
      engine: new FakeEngine(Array(8).fill(DONE)),
    });
    await drain(run);
    expect(turns(run)).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
    expect(run.status).toBe('paused');
    expect(run.pauseReason?.type).toBe('link-budget-used');
  });

  it('an unresolved next target falls through', async () => {
    const run = new Run({
      workflow: wf([phase('a', [{ kind: 'next', to: 'nowhere' }]), phase('b')]),
      engine: new FakeEngine([DONE, DONE]),
    });
    await drain(run);
    expect(run.status).toBe('done');
    expect(turns(run)).toEqual(['a', 'b']);
  });

  it('a next on the last step works, and a self next stops after its budget', async () => {
    const run = new Run({
      workflow: wf([phase('a'), phase('z', [{ kind: 'next', to: 'a' }])]),
      engine: new FakeEngine(Array(4).fill(DONE)),
    });
    // no max: would loop forever, so only step a handful of times
    for (let i = 0; i < 5; i++) await run.step();
    expect(turns(run)).toEqual(['a', 'z', 'a', 'z']);

    const self = new Run({
      workflow: wf([phase('s', [{ kind: 'next', to: 's', max: 2 }])]),
      engine: new FakeEngine(Array(6).fill(DONE)),
    });
    await drain(self);
    expect(turns(self)).toEqual(['s', 's', 's']);
    expect(self.pauseReason?.type).toBe('link-budget-used');
  });

  it('parse and print keep next: c (max 1) byte for byte', () => {
    const text = '---\nreins: 1\nname: t\nbudget: { turns: 10, minutes: 10 }\nalways: []\n---\n\n## phase a\nnext: c (max 1)\n> a\n\n## phase b\n> b\n\n## phase c\n> c\n';
    const workflow = parseWorkflow(text).workflow!;
    expect(workflow.steps[0]!.links).toEqual([expect.objectContaining({ kind: 'next', to: 'c', max: 1 })]);
    expect(printWorkflow(workflow)).toBe(text);
  });

  it('edit() with the same content while paused at a JUMP keeps the counter off the step TURN', async () => {
    const w = wf([phase('a'), phase('b', [{ kind: 'next', to: 'a', max: 1 }])]);
    const run = new Run({ workflow: w, engine: new FakeEngine(Array(6).fill(DONE)) });
    await run.step(); // a
    await run.step(); // b
    // the counter now sits on b's JUMP
    const before = (run.snapshot() as any).programCounter;
    run.edit(JSON.parse(JSON.stringify(w)));
    expect((run.snapshot() as any).programCounter).toBe(before);
  });
});

describe('Task 3: on-fail on a run step', () => {
  const failing = async () => ({ exitCode: 1, stdout: '', stderr: '' });

  it('jumps to the on-fail target after a failing command, and falls through on a pass', async () => {
    const mk = () => wf([runStep('r', 'false', [{ kind: 'on-fail', to: 'fix', max: 2 }]), phase('mid'), phase('fix')]);
    const bad = new Run({ workflow: mk(), engine: new FakeEngine([DONE, DONE]), commandRunner: failing });
    await drain(bad);
    expect(turns(bad)).toEqual(['fix']);

    const ok = new Run({
      workflow: mk(),
      engine: new FakeEngine([DONE, DONE]),
      commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });
    await drain(ok);
    expect(turns(ok)).toEqual(['mid', 'fix']);
  });

  it('the third failure pauses with link-budget-used, allowMore(1) takes one more jump', async () => {
    let n = 0;
    const run = new Run({
      workflow: wf([phase('fix'), runStep('r', 'false', [{ kind: 'on-fail', to: 'fix', max: 2 }])]),
      engine: new FakeEngine(Array(8).fill(DONE)),
      commandRunner: async () => { n++; return { exitCode: 1, stdout: '', stderr: '' }; },
    });
    await drain(run);
    expect(n).toBe(3);
    expect(run.pauseReason?.type).toBe('link-budget-used');
    expect(turns(run)).toEqual(['fix', 'fix', 'fix']);

    run.allowMore(1);
    await drain(run);
    expect(n).toBe(4);
    expect(turns(run).length).toBe(4);
    expect(run.pauseReason?.type).toBe('link-budget-used');
  });

  it('inside a repeat, on-fail back to an earlier child skips LOOP_BK: only the link budget limits it', async () => {
    const rep: Step = {
      id: 'rep',
      kind: 'repeat',
      cond: { t: 'cmd', cmd: 'npm test' },
      attrs: { max: '2' },
      cards: [],
      links: [],
      kids: [phase('fix'), runStep('r', 'false', [{ kind: 'on-fail', to: 'fix', max: 4 }])],
    };
    const run = new Run({
      workflow: wf([rep]),
      engine: new FakeEngine(Array(10).fill(DONE)),
      commandRunner: failing,
    });
    await drain(run);
    expect(turns(run).length).toBe(5);
    expect(run.pauseReason?.type).toBe('link-budget-used');
  });
});

describe('Task 4: validator, wires that cannot work', () => {
  const diags = (steps: Step[]) => validate(wf(steps));
  const L = (kind: Link['kind'], to: string, max?: number): Link => ({ kind, to, ...(max !== undefined ? { max } : {}) });

  it.each([
    ['on-pass', '`on-pass` has no effect; use `next`'],
    ['retry', '`retry` has no effect; use a backward `next` with `max`'],
    ['verify-against', '`verify-against` has no effect; use `against:`'],
    ['hand-off', '`hand-off` has no effect; use a handoff step'],
  ] as const)('warns about the deprecated %s wire', (kind, msg) => {
    const d = diags([phase('a'), phase('b', [L(kind, 'a', 1)])]);
    expect(d.filter((x) => x.severity === 'error')).toEqual([]);
    expect(d.map((x) => x.message)).toContain(msg);
  });

  it('warns about on-fail on a step that cannot fail, naming kinds from the registry and not the step', () => {
    const d = diags([phase('a'), phase('step-b', [L('on-fail', 'a', 1)])]);
    const w = d.filter((x) => x.message.startsWith('on-fail only applies to'));
    expect(w).toHaveLength(1);
    expect(w[0]!.severity).toBe('warning');
    expect(w[0]!.message).toBe('on-fail only applies to run, verify');
    expect(d.some((x) => x.message.includes('step-b'))).toBe(false);
  });

  it('does not warn about on-fail on run or verify', () => {
    const d = diags([
      phase('a'),
      runStep('r', 'x', [L('on-fail', 'a', 1)]),
      { id: 'v', kind: 'verify', attrs: { against: 'a' }, cards: [], links: [L('on-fail', 'a', 1)] },
    ]);
    expect(d.filter((x) => x.message.startsWith('on-fail only'))).toEqual([]);
  });

  it('errors on two next links, or two on-fail links, on one step', () => {
    const next = diags([phase('a', [L('next', 'b'), L('next', 'c')]), phase('b'), phase('c')]);
    expect(next.filter((x) => x.severity === 'error').map((x) => x.message)).toEqual(['a step can have only one `next` link']);
    const fail = diags([phase('a'), runStep('r', 'x', [L('on-fail', 'a', 1), L('on-fail', 'a', 2)])]);
    expect(fail.filter((x) => x.severity === 'error').map((x) => x.message)).toEqual(['a step can have only one `on-fail` link']);
  });

  const rep = (id: string, kids: Step[], links: Link[] = []): Step => ({
    id, kind: 'repeat', attrs: { max: '2' }, cond: { t: 'tests' } as Step['cond'], cards: [], links, kids,
  });

  it('errors on a wire from outside a repeat into its body, including its first child', () => {
    for (const target of ['k1', 'k2']) {
      const d = diags([phase('a', [L('next', target)]), rep('loop', [phase('k1'), phase('k2')])]);
      expect(d.filter((x) => x.severity === 'error').map((x) => x.message)).toEqual([
        'wire jumps into the body of `loop`; point at the loop instead',
      ]);
    }
  });

  it('errors on the repeat own next into its child, but not on wires inside or to the loop', () => {
    const own = diags([phase('z'), rep('loop', [phase('k1')], [L('next', 'k1', 1)])]);
    expect(own.filter((x) => x.severity === 'error')).toHaveLength(1);
    const ok = diags([
      phase('a', [L('next', 'loop')]),
      rep('loop', [phase('k1', [L('next', 'k2')]), phase('k2', [L('next', 'out')])]),
      phase('out'),
    ]);
    expect(ok.filter((x) => x.severity === 'error')).toEqual([]);
  });
});

describe('Task 5: unreachable steps', () => {
  const never = (w: Workflow) => validate(w).filter((x) => x.message.includes('never reached'));
  const rep = (id: string, kids: Step[], links: Link[] = []): Step => ({
    id, kind: 'repeat', attrs: { max: '2' }, cond: { t: 'tests' } as Step['cond'], cards: [], links, kids,
  });

  it('warns once at a step that a next skips over', () => {
    const w = wf([phase('a', [{ kind: 'next', to: 'c' }]), phase('b'), phase('c')]);
    w.steps[1]!.pos = { line: 7, col: 1 };
    const d = never(w);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: 'warning', message: 'step `b` is never reached', pos: { line: 7, col: 1 } });
  });

  it('no never-reached warning on any shipped example', () => {
    const dir = fileURLToPath(new URL('../../../examples/', import.meta.url));
    const files = [...readdirSync(dir).filter((f) => f.endsWith('.reins.md')).map((f) => dir + f), dir + 'blocks/review-pass.reins.md'];
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const w = parseWorkflow(readFileSync(f, 'utf8')).workflow!;
      expect(never(w)).toEqual([]);
    }
  });

  it('no shipped example carries a wire warning (deprecated link, dead on-fail, jump into a loop)', () => {
    const dir = fileURLToPath(new URL('../../../examples/', import.meta.url));
    const files = [...readdirSync(dir).filter((f) => f.endsWith('.reins.md')).map((f) => dir + f), dir + 'blocks/review-pass.reins.md'];
    for (const f of files) {
      const { workflow } = parseWorkflow(readFileSync(f, 'utf8'));
      const wire = validate(workflow!).filter((d) => /no effect|on-fail only|wire jumps|never reached/.test(d.message));
      expect(wire, f).toEqual([]);
    }
  });

  it('a loop whose last child has a next out of it does not flag the loop', () => {
    const w = wf([rep('R', [phase('a'), phase('b', [{ kind: 'next', to: 'out' }])]), phase('out')]);
    expect(never(w)).toEqual([]);
  });

  it('a run with onPassJump, on-fail and next flags nothing', () => {
    const w = wf([
      phase('fix'),
      rep('R', [runStep('t', 'npm test', [{ kind: 'on-fail', to: 'fix', max: 2 }, { kind: 'next', to: 'out' }])]),
      phase('skipped-by-nothing'),
      phase('out'),
    ]);
    expect(never(w)).toEqual([]);
  });

  it('a backward next that loops is not flagged', () => {
    const w = wf([phase('a'), phase('b'), phase('c', [{ kind: 'next', to: 'a', max: 1 }])]);
    expect(never(w)).toEqual([]);
  });

  it('does not run when the workflow already has an error', () => {
    const w = wf([phase('a', [{ kind: 'next', to: 'c' }]), phase('b'), phase('c'), phase('c')]);
    const d = validate(w);
    expect(d.some((x) => x.severity === 'error')).toBe(true);
    expect(d.filter((x) => x.message.includes('never reached'))).toEqual([]);
  });
});