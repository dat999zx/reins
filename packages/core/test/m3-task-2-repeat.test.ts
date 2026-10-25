// M3 Task 2: `repeat` finds "the first child runs a command" and "the loop's condition is that command" by name in the registries
// (an op with `ranCommand`, an atom with `sameAsRun`), not by the names run, tests and cmd. The compiled program must not change.
import { describe, it, expect } from 'vitest';
import { compileProgram, parseWorkflow, register, registerCondition, type CondType, type NodeType } from '../src/index.js';

declare module '../src/model.js' {
  interface NodeKinds { shout: true }
  interface CondAtoms { quiet: { t: 'quiet' }; loud: { t: 'loud' } }
}
declare module '../src/compile.js' {
  interface Instrs { SHOUT: { step: string; cmd: string; onPassJump?: number; loopExit?: number; repeatCond?: unknown } }
}

const wf = (body: string) => parseWorkflow(`---\nreins: 1\nname: t\nbudget: { turns: 9, minutes: 9 }\nalways: []\n---\n\n${body}\n`).workflow!;
const runOf = (body: string) => compileProgram(wf(body)).find((i) => i.op === 'RUN') as { onPassJump?: number; loopExit?: number; repeatCond?: unknown } | undefined;

describe('M3 Task 2: repeat leaves a loop as soon as its own command passes', () => {
  it.each([
    ['tests pass, a run of npm test', '## repeat\nuntil: tests pass\nmax: 3\n\n### run `npm test`\n', true],
    ['tests pass, a run with no command', '## repeat\nuntil: tests pass\nmax: 3\n\n### run\n', true],
    ['tests pass, a run of another command', '## repeat\nuntil: tests pass\nmax: 3\n\n### run `npm run lint`\n', false],
    ['the same command passes', '## repeat\nuntil: `npm run lint` passes\nmax: 3\n\n### run `npm run lint`\n', true],
    ['another command passes', '## repeat\nuntil: `npm run build` passes\nmax: 3\n\n### run `npm run lint`\n', false],
    ['a command passes, a run with no command', '## repeat\nuntil: `` passes\nmax: 3\n\n### run\n', true],
    ['approve, a run of npm test', '## repeat\nuntil: you approve\nmax: 3\n\n### run `npm test`\n', false],
    ['not tests pass', '## repeat\nuntil: not tests pass\nmax: 3\n\n### run `npm test`\n', false],
    ['tests pass, the run is not the first child', '## repeat\nuntil: tests pass\nmax: 3\n\n### phase fix\n> fix\n\n### run `npm test`\n', false],
    ['tests pass, a phase first', '## repeat\nuntil: tests pass\nmax: 3\n\n### phase fix\n> fix\n', false],
  ])('%s', (_n, body, jumps) => {
    const r = runOf(body);
    if (r === undefined) { expect(jumps).toBe(false); return; }
    expect(r.onPassJump !== undefined).toBe(jumps);
    if (jumps) expect(r.onPassJump).toBe(r.loopExit);
  });
});

describe('M3 Task 2: a block and a condition that are not built in take part by their hooks', () => {
  const shout: NodeType = {
    kind: 'shout', attrs: ['cmd'],
    compile(step, ctx) { ctx.push({ op: 'SHOUT', step: step.id, cmd: step.attrs.cmd || '' }); },
    ops: { SHOUT: { async exec(_i, vm) { vm.next(); }, ranCommand: true } },
  };
  const loud: CondType<{ t: 'loud' }> = {
    t: 'loud', parse(s) { if (!s.src.startsWith('loud', s.idx)) return null; s.idx += 4; return { t: 'loud' }; }, print: () => 'loud', judge: 'deterministic', evalSync: () => true,
    sameAsRun: () => true,
  };
  const quiet: CondType<{ t: 'quiet' }> = {
    t: 'quiet', parse(s) { if (!s.src.startsWith('quiet', s.idx)) return null; s.idx += 5; return { t: 'quiet' }; }, print: () => 'quiet', judge: 'deterministic', evalSync: () => true,
    sameAsRun() { throw new Error('boom'); },
  };
  const shoutInstr = (body: string) => compileProgram(wf(body)).find((i) => i.op === 'SHOUT') as { onPassJump?: number } | undefined;

  it('a hook that says yes does not set the jump on a block that is not RUN (only RUN takes it), and a throwing hook is "no", not an error', () => {
    const offs = [register(shout, 200), registerCondition(loud, 200), registerCondition(quiet, 210)];
    try {
      expect(() => compileProgram(wf('## repeat\nuntil: loud\nmax: 3\n\n### shout `x`\n'))).not.toThrow();
      expect(shoutInstr('## repeat\nuntil: loud\nmax: 3\n\n### shout `x`\n')?.onPassJump).toBeUndefined();
      expect(() => compileProgram(wf('## repeat\nuntil: quiet\nmax: 3\n\n### shout `x`\n'))).not.toThrow();
      expect(compileProgram(wf('## repeat\nuntil: quiet\nmax: 3\n\n### shout `x`\n')).map((i) => i.op)).toEqual(['LOOP_IN', 'SHOUT', 'LOOP_BK', 'END']);
    } finally {
      for (const off of offs.reverse()) off();
    }
  });

  it('a block with no ranCommand op never asks the atom', () => {
    let asked = 0;
    const spy: CondType<{ t: 'loud' }> = { ...loud, sameAsRun: () => { asked++; return true; } };
    const offs = [registerCondition(spy, 200)];
    try {
      compileProgram(wf('## repeat\nuntil: loud\nmax: 3\n\n### phase fix\n> fix\n'));
      expect(asked).toBe(0);
    } finally {
      for (const off of offs) off();
    }
  });
});
