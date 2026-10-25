// M3 group Y: the loop block is a pack mod, so it cannot reach into the instructions of the body. It calls `ctx.loopBody(step, from, exit)`, and core hands the loop to each
// instruction whose op has `inLoop` (the run block's). These tests pin the contract of that call with kinds of their own: what a hook is told, what a patch may change, who is
// reached, and that a mod's hook (and a mod's compile) cannot do more than its own instructions.
import { afterEach, describe, expect, it } from 'vitest';
import { compileProgram, parseWorkflow, register, registerCondition, type Cond, type CondType, type NodeType } from '../src/index.js';

declare module '../src/model.js' {
  interface NodeKinds { lpa: true; lpb: true; lpmod: true; lpbad: true; lpevil: true }
  interface CondAtoms { lpyes: { t: 'lpyes' }; lpno: { t: 'lpno' } }
}
type Body = { step: string; cmd?: string; seen?: unknown; repeatCond?: Cond; loopExit?: number; onPassJump?: number; mark?: string };
declare module '../src/compile.js' {
  interface Instrs { LPA: Body; LPB: Body; LPMOD: Body; LPBAD: Body; LPEVIL: Body }
}

const wf = (body: string) => parseWorkflow(`---\nreins: 1\nname: t\nbudget: { turns: 9, minutes: 9 }\nalways: []\n---\n\n${body}\n`).workflow!;
const disposers: Array<() => void> = [];
afterEach(() => { for (const d of disposers.splice(0).reverse()) d(); });

const yes: CondType<{ t: 'lpyes' }> = { t: 'lpyes', parse(s) { if (!s.src.startsWith('lpyes', s.idx)) return null; s.idx += 5; return { t: 'lpyes' }; }, print: () => 'lpyes', judge: 'deterministic', evalSync: () => true, sameAsRun: () => true };
const no: CondType<{ t: 'lpno' }> = { t: 'lpno', parse(s) { if (!s.src.startsWith('lpno', s.idx)) return null; s.idx += 4; return { t: 'lpno' }; }, print: () => 'lpno', judge: 'deterministic', evalSync: () => true, sameAsRun: () => false };

/** A kind that compiles to one instruction of `op` and takes the loop with `hook`. `ran`: its op says it runs a command. */
const body = (kind: 'lpa' | 'lpb' | 'lpmod' | 'lpbad' | 'lpevil', op: 'LPA' | 'LPB' | 'LPMOD' | 'LPBAD' | 'LPEVIL', inLoop: unknown, over: Partial<NodeType> = {}, ran = true): NodeType => ({
  kind, attrs: ['cmd'],
  compile(step, ctx) { ctx.push({ op, step: step.id, cmd: step.attrs.cmd || '' } as never); },
  ops: { [op]: { async exec(_i: unknown, vm: { next(): void }) { vm.next(); }, ...(ran ? { ranCommand: true as const } : {}), ...(inLoop ? { inLoop } : {}) } } as never,
  ...over,
});
const on = (...n: Array<() => void>) => { disposers.push(...n); };
const find = (body_: string, op: string) => compileProgram(wf(body_)).find((i) => i.op === op) as unknown as Body | undefined;
const LOOP = (cond: string, kids: string) => `## repeat\nuntil: ${cond}\nmax: 3\n\n${kids}`;

describe('M3 group Y: ctx.loopBody hands the loop to the instructions that take it', () => {
  it('the hook is told the condition, the exit and whether the loop ends on this command; the patch lands on the instruction', () => {
    const calls: unknown[] = [];
    on(registerCondition(yes, 300), register(body('lpa', 'LPA', (i: Body, loop: unknown) => { calls.push(loop); return { repeatCond: (loop as { cond: Cond }).cond, loopExit: (loop as { exit: number }).exit, mark: 'taken' }; })));
    const p = compileProgram(wf(LOOP('lpyes', '### lpa `x`\n')));
    const i = p.find((x) => x.op === 'LPA') as unknown as Body;
    expect(calls).toEqual([{ cond: { t: 'lpyes' }, exit: 3, passes: true }]);
    expect(i).toMatchObject({ repeatCond: { t: 'lpyes' }, loopExit: 3, mark: 'taken' });
    expect(p.map((x) => x.op)).toEqual(['LOOP_IN', 'LPA', 'LOOP_BK', 'END']);
    // taken: the loop's own check has no condition left to judge
    expect((p.find((x) => x.op === 'LOOP_BK') as { cond?: Cond }).cond).toBeUndefined();
  });

  it('no hook took it: the loop keeps its condition', () => {
    on(registerCondition(yes, 300), register(body('lpa', 'LPA', undefined)));
    const bk = compileProgram(wf(LOOP('lpyes', '### lpa `x`\n'))).find((x) => x.op === 'LOOP_BK') as { cond?: Cond };
    expect(bk.cond).toEqual({ t: 'lpyes' });
  });

  it('`passes` is true only for the first instruction of the body, only when its block runs a command and the atom says it is that command', () => {
    const seen: Array<{ at: string; passes: boolean }> = [];
    const hook = (at: string) => (_i: Body, loop: { passes: boolean }) => { seen.push({ at, passes: loop.passes }); return {}; };
    on(registerCondition(yes, 300), registerCondition(no, 310), register(body('lpa', 'LPA', hook('a'))), register(body('lpb', 'LPB', hook('b'))));
    compileProgram(wf(LOOP('lpyes', '### lpa `x`\n\n### lpb `y`\n')));
    expect(seen).toEqual([{ at: 'a', passes: true }, { at: 'b', passes: false }]);
    seen.length = 0;
    compileProgram(wf(LOOP('lpno', '### lpa `x`\n')));
    expect(seen).toEqual([{ at: 'a', passes: false }]);
    seen.length = 0;
    compileProgram(wf(LOOP('lpyes', '### lpb `y`\n\n### lpa `x`\n')));
    expect(seen).toEqual([{ at: 'b', passes: true }, { at: 'a', passes: false }]);
  });

  it('a first kid whose op does not run a command never has the atom asked', () => {
    let asked = 0;
    const spy: CondType<{ t: 'lpyes' }> = { ...yes, sameAsRun: () => { asked++; return true; } };
    const seen: boolean[] = [];
    on(registerCondition(spy, 300), register(body('lpa', 'LPA', (_i: Body, loop: { passes: boolean }) => { seen.push(loop.passes); return {}; }, {}, false)));
    compileProgram(wf(LOOP('lpyes', '### lpa `x`\n')));
    expect(asked).toBe(0);
    expect(seen).toEqual([false]);
  });

  it('a throwing atom is "no"', () => {
    const bad: CondType<{ t: 'lpyes' }> = { ...yes, sameAsRun() { throw new Error('boom'); } };
    const seen: boolean[] = [];
    on(registerCondition(bad, 300), register(body('lpa', 'LPA', (_i: Body, loop: { passes: boolean }) => { seen.push(loop.passes); return {}; })));
    expect(() => compileProgram(wf(LOOP('lpyes', '### lpa `x`\n')))).not.toThrow();
    expect(seen).toEqual([false]);
  });

  it('a loop with no condition calls nothing and takes nothing', () => {
    let called = 0;
    on(register(body('lpa', 'LPA', () => { called++; return { mark: 'taken' }; })));
    const p = compileProgram(wf('## repeat\nmax: 3\n\n### lpa `x`\n'));
    expect(called).toBe(0);
    expect(p.find((x) => x.op === 'LPA')).not.toHaveProperty('mark');
  });

  it('a patch never changes op, step or top, and never sets a prototype; the other fields land', () => {
    const evil = JSON.parse('{"op":"END","step":"other","top":99,"__proto__":{"polluted":true},"mark":"ok"}');
    on(registerCondition(yes, 300), register(body('lpa', 'LPA', () => evil)));
    const p = compileProgram(wf(LOOP('lpyes', '### lpa `x`\n')));
    const i = p.find((x) => x.op === 'LPA') as unknown as Body & { top: number };
    expect(i).toMatchObject({ op: 'LPA', step: 'lpa-1', top: 0, mark: 'ok' });
    expect(Object.getPrototypeOf(i)).toBe(Object.prototype);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('a patch that is not an object (text, a number, a list) takes nothing', () => {
    for (const answer of ['text', 7, [1, 2], null]) {
      const offs = [registerCondition(yes, 300), register(body('lpa', 'LPA', () => answer))];
      try {
        const p = compileProgram(wf(LOOP('lpyes', '### lpa `x`\n')));
        expect(Object.keys(p.find((x) => x.op === 'LPA')!).sort()).toEqual(['cmd', 'op', 'step', 'top']);
        expect((p.find((x) => x.op === 'LOOP_BK') as { cond?: Cond }).cond).toEqual({ t: 'lpyes' });
      } finally { for (const off of offs.reverse()) off(); }
    }
  });

  it('every instruction of the body is reached, nested loops included; the nearer loop is told first and the outer one has the last word', () => {
    const told: Array<[string, number]> = [];
    on(registerCondition(yes, 300), register(body('lpa', 'LPA', (_i: Body, loop: { exit: number; cond: Cond }) => { told.push([loop.cond.t, loop.exit]); return { loopExit: loop.exit }; })));
    const p = compileProgram(wf(LOOP('lpyes', '### repeat\nuntil: lpyes\nmax: 2\n\n#### lpa `x`\n\n### lpa `y`\n')));
    expect(p.map((x) => x.op)).toEqual(['LOOP_IN', 'LOOP_IN', 'LPA', 'LOOP_BK', 'LPA', 'LOOP_BK', 'END']);
    expect(told).toEqual([['lpyes', 4], ['lpyes', 6], ['lpyes', 6]]);
    expect((p[2] as unknown as Body).loopExit).toBe(6);
    expect((p[4] as unknown as Body).loopExit).toBe(6);
  });
});

describe('M3 group Y: a mod\'s hook and a mod\'s compile reach no further than their own instructions', () => {
  const mod = (extra: Partial<NodeType>) => ({ mod: { id: 'lp', events: [] as string[] }, ...extra });

  it('a mod\'s inLoop that throws, or answers something that is not an object, takes nothing, and breaks nothing', () => {
    for (const answer of [() => { throw new Error('boom'); }, () => 'text', () => 7, () => null, () => undefined, () => [1, 2]]) {
      const offs = [registerCondition(yes, 300), register(body('lpmod', 'LPMOD', answer, mod({})))];
      try {
        const p = compileProgram(wf(LOOP('lpyes', '### lpmod `x`\n')));
        expect((p.find((x) => x.op === 'LOOP_BK') as { cond?: Cond }).cond).toEqual({ t: 'lpyes' });   // nothing took the condition
        expect(Object.keys(p.find((x) => x.op === 'LPMOD')!).sort()).toEqual(['cmd', 'op', 'step', 'top']);   // not one field was added
      } finally { for (const off of offs.reverse()) off(); }
    }
  });

  it('a mod\'s hook is given a copy: what it writes into its argument stays out of the program', () => {
    on(registerCondition(yes, 300), register(body('lpmod', 'LPMOD', (i: Body & { extra?: number }, loop: { cond: Cond }) => { i.mark = 'written'; i.extra = 1; (loop.cond as { t: string }).t = 'lpno'; return {}; }, mod({}))));
    const w = wf(LOOP('lpyes', '### lpmod `x`\n'));
    const p = compileProgram(w);
    expect(Object.keys(p.find((x) => x.op === 'LPMOD')!).sort()).toEqual(['cmd', 'op', 'step', 'top']);
    expect(w.steps[0]!.cond).toEqual({ t: 'lpyes' });   // the loop's own condition, which the hook was told about
  });

  it('a mod\'s patch is a copy of plain data: the hook cannot keep a handle on the instruction', () => {
    const patch = { repeatCond: { t: 'lpyes' } as Cond, mark: 'm' };
    on(registerCondition(yes, 300), register(body('lpmod', 'LPMOD', () => patch, mod({}))));
    const i = find(LOOP('lpyes', '### lpmod `x`\n'), 'LPMOD')!;
    expect(i.mark).toBe('m');
    expect(i.repeatCond).not.toBe(patch.repeatCond);
    expect(Object.isFrozen(i)).toBe(true);
  });

  it('a mod\'s compile that calls loopBody from a later step reaches none of the earlier steps\' instructions, only its own', () => {
    let reached = 0;
    on(registerCondition(yes, 300),
      register(body('lpa', 'LPA', () => { reached++; return { mark: 'earlier' }; })),
      register(body('lpevil', 'LPEVIL', () => { reached++; return { mark: 'own' }; }, mod({
        compile(step, ctx) {
          ctx.push({ op: 'LPEVIL', step: step.id } as never);
          ctx.loopBody({ ...step, cond: { t: 'lpyes' } }, 0, 99);
        },
      }))));
    const p = compileProgram(wf('## lpa `x`\n\n## lpevil\n'));
    expect(p.find((x) => x.op === 'LPA')).not.toHaveProperty('mark');
    expect((p.find((x) => x.op === 'LPEVIL') as unknown as Body).mark).toBe('own');
    expect(reached).toBe(1);
  });

  it('a bad compile of a mod still leaves the fault instruction, as for any compile that throws', () => {
    on(register(body('lpbad', 'LPBAD', undefined, mod({ compile() { throw new Error('nope'); } }))));
    expect(compileProgram(wf('## lpbad\n')).map((x) => x.op)).toEqual(['!fault', 'END']);
  });
});
