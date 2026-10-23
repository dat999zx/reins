// The `if` block of the default pack: runs its steps when a condition holds, the else steps when it does not. It reads the condition from the heading through
// `parseCond` and `printCond` of `api.core`.
import type { Cond, Instr, NodeType, OpType } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface NodeKinds { if: true }
  interface ModInstrs { IF: { step: string; cond: Cond; elseJump: number } }
}

const IF: OpType<Extract<Instr, { op: 'IF' }>> = {
  async exec(i, vm) {
    const passed = await vm.judge(i.cond);
    if (!vm.running()) return;
    if (passed) {
      vm.next();
    } else {
      vm.goto(i.elseJump);
    }
  },
  next: (i, at) => [at + 1, i.elseJump],
};

export default function activate(api: Pick<ModApi, 'registerBlock' | 'core'>): void {
  const { parseCond, printCond } = api.core;
  const ifNode: NodeType = {
    kind: 'if',
    attrs: [],
    container: 'kids+else',
    heading: {
      parse(arg, step, ctx) {
        const r = parseCond(arg, { line: ctx.line, col: ctx.col });
        if (r.diag) ctx.push(r.diag);
        if (r.cond) step.cond = r.cond;
        return true;
      },
      print(step) { return { text: step.cond ? `if ${printCond(step.cond)}` : 'if', condInHeading: true }; },
    },
    compile(step, ctx) {
      const ifInstr = ctx.push({ op: 'IF', step: step.id, cond: step.cond || { t: 'done' }, elseJump: 0 });

      if (step.kids) ctx.compile(step.kids);

      if (step.else && step.else.length > 0) {
        const jumpEnd = ctx.push({ op: 'JUMP', target: 0 });
        ifInstr.elseJump = ctx.at();
        ctx.compile(step.else);
        jumpEnd.target = ctx.at();
      } else {
        ifInstr.elseJump = ctx.at();
      }
    },
    ops: { IF },
  };
  api.registerBlock(ifNode);
}
