import type { NodeType, OpType } from './index.js';
import type { Instr } from '../compile.js';

declare module '../model.js' {
  interface NodeKinds { repeat: true }
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
    let hasRunInstr = false;

    if (step.cond) {
      for (let i = bodyStart; i < ctx.at(); i++) {
        const inst = ctx.get(i);
        if (inst && inst.op === 'RUN') {
          inst.repeatCond = step.cond;
          inst.loopExit = loopExit;
          hasRunInstr = true;
        }
      }
    }

    const firstKid = step.kids?.[0];
    const isRunMatch =
      firstKid?.kind === 'run' &&
      step.cond !== undefined &&
      ((step.cond.t === 'cmd' && step.cond.cmd === (firstKid.attrs.cmd || '')) ||
        (step.cond.t === 'tests' &&
          (firstKid.attrs.cmd === 'npm test' || !firstKid.attrs.cmd)));

    if (isRunMatch) {
      const runInstr = ctx.get(bodyStart);
      if (runInstr && runInstr.op === 'RUN') {
        runInstr.onPassJump = loopExit;
      }
    }

    ctx.push({
      op: 'LOOP_BK',
      step: step.id,
      target: bodyStart,
      cond: hasRunInstr ? undefined : step.cond,
    });
  },
  ops: { LOOP_IN, LOOP_BK },
};
export default repeat;
