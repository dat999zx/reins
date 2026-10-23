import { NODES, type NodeType, type OpType } from './index.js';
import type { Instr } from '../compile.js';
import { CONDS } from '../conds/index.js';

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

    // Looked up by name in the registries, so this file holds no kind or condition of its own: the first child runs a command (its op says so)
    // and the loop's condition is judged by that same command (its atom says so). A throwing atom hook is "no".
    const firstKid = step.kids?.[0];
    const kidRuns = firstKid !== undefined && Object.values(NODES.get(firstKid.kind)?.ops ?? {}).some((o) => o.ranCommand === true);
    const isRunMatch =
      kidRuns &&
      step.cond !== undefined &&
      (() => { try { return CONDS.get(step.cond!.t)?.sameAsRun?.(step.cond, firstKid.attrs.cmd || '') === true; } catch { return false; } })();

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
  count: { loop_iteration: () => 'loopAttempts' },
  print: { loop_iteration: (d) => `↻ ${d.step}: attempt ${d.attempts}` },
};
export default repeat;
