import type { NodeType, OpType } from './index.js';
import type { Instr } from '../compile.js';

declare module '../model.js' {
  interface NodeKinds { gate: true }
}

const GATE: OpType<Extract<Instr, { op: 'GATE' }>> = {
  async exec(i, vm) {
    if (i.cond.t !== 'approve') {
      const passed = await vm.judge(i.cond);
      if (!vm.running()) return;
      if (passed) {
        vm.next();
        return;
      }
    }
    vm.pause({ type: 'gate', stepId: i.step, cond: i.cond });
    vm.log('gate_paused', { step: i.step, cond: i.cond });
  },
};

const gate: NodeType = {
  kind: 'gate',
  attrs: [],
  tag: { place: 'after', lines: ['until: you approve'] },
  validate: {
    early(step, ctx) {
      if (!step.cond) {
        ctx.push({ severity: 'error', message: `gate step "${step.id}" requires until: condition`, pos: ctx.pos });
      }
    },
  },
  compile(step, ctx) { ctx.push({ op: 'GATE', step: step.id, cond: step.cond || { t: 'approve' } }); },
  ops: { GATE },
};
export default gate;
