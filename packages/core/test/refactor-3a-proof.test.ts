import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseWorkflow } from '../src/format/parse.js';
import { printWorkflow } from '../src/format/print.js';
import { validate } from '../src/validate.js';
import { compileProgram, compileTurn } from '../src/compile.js';
import { parseCond, printCond, judgeOf } from '../src/cond.js';
import { Run } from '../src/run.js';
import { FakeEngine } from '../src/fake-engine.js';
import type { Workflow } from '../src/model.js';
import { golden, hash } from './golden-3a/stable.js';
import { generateTrees } from './golden-3a/gen.js';

const EX = path.resolve(__dirname, '../../../examples');
const readEx = (f: string) => fs.readFileSync(path.join(EX, f), 'utf8').replace(/\r\n/g, '\n');
const exBlocks = (name: string) => {
  const p = path.join(EX, 'blocks', `${name}.reins.md`);
  return fs.existsSync(p) ? parseWorkflow(fs.readFileSync(p, 'utf8')).workflow : undefined;
};
const FM = '---\nreins: 1\nname: t\nbudget: { turns: 20, minutes: 20 }\n---\n\n';
const WF = (body: string, fm = FM) => fm + body + '\n';

/** A program plus the compiled text of every TURN in it. */
function compiled(w: Workflow, resolveBlock?: (n: string) => Workflow | undefined) {
  const program = compileProgram(w, resolveBlock);
  const turns = program.flatMap((i) => (i.op === 'TURN' && i.src
    ? [compileTurn(i.src, { workflowName: w.name, stepIndex: i.top ?? 0, totalSteps: w.steps.length, always: w.always })]
    : []));
  return { program, turns };
}

describe('3a proof: compile', () => {
  it('examples compile the same', () => {
    const out: Record<string, unknown> = {};
    for (const f of ['upload-retry', 'bug-fix', 'tdd-loop', 'safe-refactor']) {
      out[f] = compiled(parseWorkflow(readEx(`${f}.reins.md`)).workflow!, exBlocks);
    }
    golden('a-examples.json', out);
  });

  it('generated trees compile the same', () => {
    const trees = generateTrees(200);
    expect(trees[0]).toBeDefined();
    golden('a-trees.json', trees.map((t) => hash(compiled(t))));
  });

  it('hand trees compile the same', () => {
    const REPEAT = '## repeat\nuntil: tests pass\nmax: 3\n\n### run `npm test`\n\n### phase fix\n> fix it';
    const FM_TEST = '---\nreins: 1\nname: t\ntest: pnpm test\nbudget: { turns: 20, minutes: 20 }\n---\n\n';
    const vblock = (n: string) =>
      n === 'vblock'
        ? parseWorkflow('---\nblock: vblock\n---\n\n## phase plan\n> p\n\n## verify\nagainst: plan\non-fail: plan (max 1)\n').workflow
        : exBlocks(n);
    const inputs: Array<{ text: string; resolve: (n: string) => Workflow | undefined }> = [
      { text: WF(REPEAT), resolve: exBlocks },
      { text: WF(REPEAT, FM_TEST), resolve: exBlocks },
      { text: WF('## repeat\nuntil: tests pass\nmax: 2\n\n### run\n\n### phase fix\n> fix'), resolve: exBlocks },
      { text: WF('## gate\n\n## if\n\n### say\n> inside'), resolve: exBlocks },
      { text: WF('## verify\nagainst: plan\non-fail: mystery-1 (max 2)\n\n## phase plan\n> p\n\n## mystery\n> m'), resolve: exBlocks },
      { text: WF('## use vblock'), resolve: vblock },
      {
        text: WF('## phase all cards\nguard: migrations/**\nnote: n1\nnudge: n2\nrole: n3\ncheckpoint: n4\nbudget: n5\nundo: n6\nmode: read-only\n> do'),
        resolve: exBlocks,
      },
    ];
    const out = inputs.map(({ text, resolve }) => {
      const p = parseWorkflow(text);
      return { diags: p.diagnostics, compiled: p.workflow ? compiled(p.workflow, resolve) : null };
    });
    golden('a-hand.json', out);
  });
});

describe('3a proof: parse and validate', () => {
  it('diagnostics and parsed shape are the same', () => {
    const inputs = [
      WF('## frobnicate\n> x'),
      WF('## phase a\ngaurd: x\n> x'),
      WF('## phase a\n> a\n\n## else\n\n## phase b\n> b\n\n## whenever drift\nnudge: n'),
      WF('## repeat\nmax: 2\nuntil: tests pass\n\n### whenever drift\nnudge: deep\n\n### run `npm test`'),
      WF('## phase a\nnow: go\nstop: halt\n> a'),
      WF('## phase a\nguard: [oops\n> a\n\n## gate\nuntil: touches [x'),
      WF('## repeat\nuntil: tests pass\n\n### say\n> s\n\n## gate'),
      WF('## use nope'),
      WF('## phase empty'),
      WF('## phase a\n> a\n\n## verify\nagainst: ghost\n\n## phase c\n> c\nretry: a'),
      WF('## gate\nuntil: reviewer approves or llm says "ok?"\n\n## repeat\nmax: 2\nuntil: tests pass\n\n### run `npm test`'),
      WF(
        '## gate\nuntil: reviewer approves or llm says "ok?"\n\n## repeat\nmax: 2\nuntil: tests pass\n\n### run `npm test`',
        '---\nreins: 1\nname: t\ntest: npm test\nbudget: { turns: 20, minutes: 20 }\n---\n\n'
      ),
      WF('## if not ((\nuntil: tests pass\n\n### say\n> s'),
      WF('## phase\n> p'),
      WF('## phase x\ncmd: foo\n> p'),
      WF('## say\nuse: foo\n> s'),
      WF('## run `a`\ncmd: b'),
      WF('## say\n> s\n\n## whenever llm says "x" and touches [\nnudge: n'),
      WF('## phase a\nnow: go\nguard: [bad\nuntil: llm says "x"'),
      WF('## phase a\n> a\n\n## verify\nagainst: ghost\non-fail: nowhere\n\n## phase c\n> c\nretry: a'),
    ];
    const out = inputs.map((text) => {
      const parsed = parseWorkflow(text);
      const w = parsed.workflow;
      return {
        steps: w?.steps.map((s) => s.id),
        tree: w?.steps,
        autos: w?.autos,
        diags: [...parsed.diagnostics, ...(w ? validate(w, exBlocks) : [])],
      };
    });
    golden('b-diags.json', out);
  });

  it('a hand-built else step gets both errors', () => {
    const w: Workflow = {
      version: 1,
      name: 't',
      budget: { turns: 20, minutes: 20 },
      always: [],
      steps: [{ id: 'e', kind: 'else' as any, attrs: {}, cards: [], links: [] }],
      autos: [],
    };
    golden('b-else.json', validate(w));
  });
});

describe('3a proof: conditions', () => {
  it('conditions parse, print and judge the same', () => {
    const strings = [
      'drifting',
      'diff>3lines',
      'diff > 3',
      'diff > 3 lines',
      'reviewer approves',
      "reviewer approves 'x'",
      'not tests pass',
      'not (drift and agent says done)',
      'drift or agent says done and same error twice',
      'you approved',
      'tests passing',
      'llm says',
      '`npm test',
      'llm says "open',
      'attempts > x',
      'touches',
      'touches src/**',
      '`npm run lint` passes',
      'attempts > 2 and not same error twice',
    ];
    golden(
      'c-conds.json',
      strings.map((s) => {
        const r = parseCond(s, { line: 3, col: 7 });
        return { s, r, print: r.cond ? printCond(r.cond) : null, judge: r.cond ? judgeOf(r.cond) : null };
      })
    );
  });
});

describe('3a proof: auto cards through a run', () => {
  function load(text: string): Workflow {
    const p = parseWorkflow(text);
    expect(p.diagnostics).toEqual([]);
    expect(validate(p.workflow!)).toEqual([]);
    return p.workflow!;
  }
  async function drive(run: Run) {
    for (let i = 0; i < 50 && run.status === 'running'; i++) await run.step();
  }
  const queued = (run: Run) => run.getEvents().filter((e) => e.type === 'card_queued').map((e) => e.data.card);
  const DONE = { text: 'ok\nREINS: done' };

  it('diff auto card goes async through diffLines', async () => {
    const workflow = load(WF('## say\n> hi\n\n## whenever diff > 3 lines\nnudge: big'));
    let calls = 0;
    const run = new Run({
      workflow,
      engine: new FakeEngine([DONE]),
      diffLines: async () => { calls++; return 10; },
    });
    await drive(run);
    expect(calls).toBeGreaterThan(0);
    expect(queued(run)).toEqual(['big']);
  });

  it('whenever not tests pass is true and runs nothing', async () => {
    const workflow = load(WF('## say\n> hi\n\n## whenever not tests pass\nnudge: nt'));
    let ran = 0;
    const run = new Run({
      workflow,
      engine: new FakeEngine([DONE]),
      commandRunner: async () => { ran++; return { exitCode: 0, stdout: '', stderr: '' }; },
    });
    await drive(run);
    expect(queued(run)).toEqual(['nt']);
    expect(ran).toBe(0);
  });

  it('a false left side keeps an and sync, and diffLines is never called', async () => {
    const workflow = load(WF('## say\n> hi\n\n## whenever agent says done and diff > 3 lines\nnudge: x'));
    let calls = 0;
    const run = new Run({
      workflow,
      engine: new FakeEngine([{ text: 'hello' }]),
      diffLines: async () => { calls++; return 10; },
    });
    await drive(run);
    expect(run.checkAutoCards()).toBeUndefined();
    expect(calls).toBe(0);

    const workflow2 = load(WF('## say\n> hi\n\n## whenever diff > 3 lines\nnudge: y'));
    const run2 = new Run({
      workflow: workflow2,
      engine: new FakeEngine([DONE]),
      diffLines: async () => 10,
    });
    await drive(run2);
    const r = run2.checkAutoCards();
    expect(r).toBeInstanceOf(Promise);
    await r;
  });

  it('sync cards queue before async ones', async () => {
    const workflow = load(WF('## say\n> hi\n\n## whenever diff > 3 lines\nnudge: A\n\n## whenever not tests pass\nnudge: B'));
    const run = new Run({
      workflow,
      engine: new FakeEngine([DONE]),
      diffLines: async () => 10,
    });
    await drive(run);
    expect(queued(run)).toEqual(['B', 'A']);
  });

  it('a now auto card reaches the next turn', async () => {
    const workflow = load(WF('## say\n> one\n\n## say\n> two\n\n## whenever not tests pass\nnow: hurry'));
    const engine = new FakeEngine([DONE, DONE]);
    const run = new Run({ workflow, engine });
    await drive(run);
    expect(engine.receivedTexts[1]).toContain('hurry');
    expect(run.getEvents().some((e) => e.type === 'card_queued' && e.data.kind === 'now')).toBe(true);
  });
});

describe('3a proof: printing', () => {
  it('the block file round-trips', () => {
    const f = 'blocks/review-pass.reins.md';
    expect(printWorkflow(parseWorkflow(readEx(f)).workflow!)).toBe(readEx(f));
  });

  it('a cmd: line on a phase does not print back', () => {
    golden('e-phase-cmd.json', printWorkflow(parseWorkflow(WF('## phase x\ncmd: foo\n> p')).workflow!));
  });
});
