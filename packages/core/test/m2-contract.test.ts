// M2 task 7: the compile and validate contract for tracks, proven by the toy `split` (fixtures/split.ts): a kind with several `next` links,
// an op that says where tracks start, the main-line walk and the region rules R1 to R3, `validate.program`, and `checkBlock`. Nothing here runs a second track.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseWorkflow } from '../src/format/parse.js';
import { printWorkflow } from '../src/format/print.js';
import { validate } from '../src/validate.js';
import { compileProgram } from '../src/compile.js';
import { register } from '../src/nodes/index.js';
import type { Diagnostic, Workflow } from '../src/model.js';
import { golden } from './golden-3a/stable.js';
import { split, seen } from './fixtures/split.js';

declare module '../src/model.js' {
  interface NodeKinds { probe: true }
}

const head = '---\nreins: 1\nname: t\nbudget: { turns: 10, minutes: 10 }\nalways: []\n---\n\n';
const wf = (body: string): Workflow => {
  const r = parseWorkflow(head + body);
  expect(r.diagnostics).toEqual([]);
  return r.workflow!;
};
const errors = (w: Workflow) => validate(w).filter((d) => d.severity === 'error').map((d) => d.message);

const disposers: Array<() => void> = [];
let blockResult: Diagnostic[] = [];
let blockToCheck: Workflow | undefined;
beforeAll(() => {
  disposers.push(register(split));
  disposers.push(register({
    kind: 'probe', attrs: [], compile() {},
    validate: { early(_s, ctx) { if (blockToCheck) blockResult = ctx.checkBlock!(blockToCheck); } },
  }));
});
afterAll(() => { for (const d of disposers.splice(0).reverse()) d(); });
beforeEach(() => { seen.length = 0; });

const stack = '## split\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n';
const a = '## phase a\n> a\n\n## end\n\n';
const b = '## phase b\n> b\n\n## end\n';

describe('a kind with several next links', () => {
  const text = head + stack + a + b;

  it('parses, prints back the same bytes, validates clean and compiles to one SPLIT with both targets in wire order and no JUMP', () => {
    const r = parseWorkflow(text);
    expect(r.diagnostics).toEqual([]);
    const w = r.workflow!;
    expect(printWorkflow(w)).toBe(text);
    expect(validate(w)).toEqual([]);
    const program = compileProgram(w);
    expect(program[0]).toEqual({ op: 'SPLIT', step: 'split-1', targets: [3, 5], top: 0 });
    expect(program.filter((i) => i.op === 'JUMP')).toEqual([]);
    expect(program.map((i) => i.op)).toEqual(['SPLIT', 'TURN', 'END', 'TURN', 'END', 'TURN', 'END', 'END']);
  });

  it('keeps the order the wires were written in', () => {
    const w = wf(stack.replace('next: a\nnext: b', 'next: b\nnext: a') + a + b);
    expect(errors(w)).toEqual([]);
    expect(compileProgram(w)[0]).toMatchObject({ op: 'SPLIT', targets: [5, 3] });
  });

  it('a phase with two next lines keeps its old error', () => {
    const w = wf('## phase p\nnext: q\nnext: r\n> p\n\n## phase q\n> q\n\n## phase r\n> r\n');
    expect(errors(w)).toEqual(['a step can have only one `next` link']);
  });
});

describe('the region rules', () => {
  it('R1: a wire to a stack block, and to a free block a stack block also links to', () => {
    const intoStack = wf('## split\nnext: main\nnext: a\n\n## phase main\n> m\n\n## end\n\n' + a);
    expect(errors(intoStack)).toEqual(['`main` starts a branch of `split-1`, so only `split-1` may start it: put it behind the end, and let nothing else lead into it']);
    const alsoLinked = wf('## split\nnext: a\n\n## phase main\nnext: a\n> m\n\n## end\n\n' + a);
    expect(errors(alsoLinked)).toEqual(['`a` starts a branch of `split-1`, so only `split-1` may start it: put it behind the end, and let nothing else lead into it']);
  });

  it('R2: two wires whose chains share a block; two splits to one chain', () => {
    const shared = wf('## split\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## phase b\n> b\n\n## end\n');
    expect(errors(shared)).toEqual(['`b` is in branch `a` and branch `b`; put an end under each branch']);
    const twice = wf('## split\nnext: a\n\n## split\nnext: a\n\n## phase main\n> m\n\n## end\n\n' + a);
    expect(errors(twice)).toEqual(['`a` is in branch `a` and branch `a`; put an end under each branch']);
  });

  it('R3: a branch block\'s on-fail into the stack', () => {
    const w = wf('## split\nnext: a\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## verify\non-fail: main (max 1)\n\n## end\n');
    expect(errors(w)).toEqual(['branch `a` of `split-1` leads back into the stack at `main`; end the branch instead']);
  });

  it('two branches that both lead back into the stack give one R3 message each and no R2 message', () => {
    const w = wf('## split\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## verify\non-fail: main (max 1)\n\n## end\n\n## phase b\n> b\n\n## verify\non-fail: main (max 1)\n\n## end\n');
    const msgs = errors(w);
    expect(msgs.filter((m) => m.includes('leads back into the stack'))).toHaveLength(2);
    expect(msgs.filter((m) => m.includes(' is in branch '))).toEqual([]);
  });

  it('a branch with a repeat, and one with an old backward next with max, are clean and not "never reached"', () => {
    const rep = wf('## split\nnext: a\n\n## phase main\n> m\n\n## end\n\n## repeat\nid: a\nuntil: you approve\nmax: 3\n\n### phase work\n> Work.\n\n## end\n');
    expect(validate(rep)).toEqual([]);
    const back = wf('## split\nnext: a\n\n## phase main\n> m\n\n## end\n\n## phase a\nnext: a (max 2)\n> a\n\n## end\n');
    expect(validate(back)).toEqual([]);
  });

  it('branches laid one after the other, each ending in an end, share nothing', () => {
    expect(validate(wf(stack + a + b))).toEqual([]);
  });
});

describe('what validate.program sees', () => {
  const nested =
    '## split\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n' +
    '## phase a\n> a\n\n## split\nnext: c\n\n## phase a2\n> a2\n\n## end\n\n' +
    '## phase c\n> c\n\n## end\n\n' +
    '## phase b\n> b\n\n## end\n';

  it('members in program order, with and without the regions started inside; trackOf names the start', () => {
    expect(validate(wf(nested))).toEqual([]);
    const outer = seen.find((s) => s.step === 'split-1')!;
    expect(outer.members).toEqual({ a: ['a', 'split-2', 'a2'], b: ['b'] });
    expect(outer.nested).toEqual({ a: ['a', 'split-2', 'a2', 'c'], b: ['b'] });
    expect(outer.trackOf).toEqual({ a: 'a', 'split-2': 'a', a2: 'a', c: 'c', b: 'b', 'split-1': undefined });
    const inner = seen.find((s) => s.step === 'split-2')!;
    expect(inner.members).toEqual({ c: ['c'] });
    expect(inner.trackOf['split-2']).toBe('a');
  });

  it('is not called on a workflow with an error', () => {
    expect(errors(wf('## split\nnext: main\n\n## phase main\n> m\n\n## end\n'))).toHaveLength(1);
    expect(seen).toEqual([]);
  });
});

describe('checkBlock', () => {
  it('returns the diagnostics of a block file validated as a block', () => {
    const w = wf('## phase p\n> p\n');
    const noBudget = { ...w, budget: {} } as Workflow;
    expect(errors(noBudget)).toEqual(['Workflow requires budget with turns and minutes']);
    blockToCheck = noBudget;
    expect(errors(wf('## probe\n'))).toEqual([]);
    expect(blockResult).toEqual([]);
    blockToCheck = wf('## phase p\nnext: nowhere\n> p\n');
    expect(errors(wf('## probe\n'))).toEqual([]);
    expect(blockResult.map((d) => d.message)).toEqual(['Link target "nowhere" not found']);
    blockToCheck = undefined;
  });
});

describe('programs of every example', () => {
  it('compile to what they did before', () => {
    const dir = path.resolve(__dirname, '../../../examples');
    const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith('.reins.md') ? [path.join(d, e.name)] : []);
    const programs: Record<string, unknown> = {};
    for (const f of files(dir).sort()) {
      const r = parseWorkflow(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'));
      programs[path.relative(dir, f).replace(/\\/g, '/')] = compileProgram(r.workflow!);
    }
    expect(Object.keys(programs).length).toBeGreaterThanOrEqual(5);
    golden('contract-examples.json', programs, 'REINS_RECORD_M2', path.join(__dirname, 'golden-m2'));
  });
});
