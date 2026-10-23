// The `repeat` block of the default pack: a loop over its kids that ends when its condition passes, or pauses when `max` attempts are used.
// It needs nothing from `api.core`. Where the loop's condition goes into a command in the body (and where the loop is left the moment that command passes) is
// the body block's own business: `ctx.loopBody` hands the loop to each instruction whose op has `inLoop` (the `run` block's), so this file names no other block.
// The `LOOP_IN` and `LOOP_BK` instructions and the `loop_iteration` and `loop_budget_exceeded` events are its own.
import type { Cond, Instr, NodeType, OpType } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface NodeKinds { repeat: true }
  interface Instrs {
    LOOP_IN: { step: string; max: number };
    LOOP_BK: { step: string; target: number; cond?: Cond };
  }
  interface RunEvents { loop_iteration: unknown; loop_budget_exceeded: unknown }
}

const LOOP_IN: OpType<Extract<Instr, { op: 'LOOP_IN' }>> = {
  async exec(_i, vm) {
    vm.next();
  },
};

const LOOP_BK: OpType<Extract<Instr, { op: 'LOOP_BK' }>> = {
  async exec(i, vm) {
    const passed = i.cond ? await vm.judge(i.cond) : false;
    if (!vm.running()) return;
    if (passed) {
      vm.next();
      return;
    }

    const attempts = vm.loops.bump(i.step);
    vm.log('loop_iteration', { step: i.step, attempts });

    // Find loop_in instruction for max
    const loopIn = vm.program.find(
      (p) => p.op === 'LOOP_IN' && p.step === i.step
    ) as { op: 'LOOP_IN'; max: number } | undefined;
    const baseMax = loopIn?.max || 5;
    const max = baseMax + vm.loops.extra(i.step);

    if (attempts >= max) {
      vm.pause({ type: 'budget-used', stepId: i.step, limit: max });
      vm.log('loop_budget_exceeded', { step: i.step, attempts, max });
      return;
    }

    vm.goto(i.target);
  },
  next: (i, at) => [at + 1, i.target],
  allowMore: (i) => i.target,
};

export default function activate(api: Pick<ModApi, 'registerBlock'>): void {
  const repeat: NodeType = {
    kind: 'repeat',
    attrs: ['max'],
    tag: { place: 'wrap', arg: 'until', argRequired: true, lines: ['max: 5'] },
    container: 'kids',
    validate: {
      early(step, ctx) {
        if (!step.attrs.max || parseInt(step.attrs.max, 10) <= 0) {
          ctx.push({ severity: 'error', message: `repeat step "${step.id}" requires max`, pos: ctx.pos });
        }
      },
    },
    compile(step, ctx) {
      const max = parseInt(step.attrs.max || '1', 10);
      ctx.push({ op: 'LOOP_IN', step: step.id, max });

      const bodyStart = ctx.at();
      if (step.kids) ctx.compile(step.kids);

      const loopExit = ctx.at() + 1;
      // A command in the body takes the condition and judges it itself: then the loop's own check has nothing left to judge.
      const taken = ctx.loopBody(step, bodyStart, loopExit);

      ctx.push({
        op: 'LOOP_BK',
        step: step.id,
        target: bodyStart,
        cond: taken ? undefined : step.cond,
      });
    },
    ops: { LOOP_IN, LOOP_BK },
    count: { loop_iteration: () => 'loopAttempts' },
    print: { loop_iteration: (d) => `↻ ${d.step}: attempt ${d.attempts}` },
  };
  api.registerBlock(repeat);
}
