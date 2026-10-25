// The `gate` block of the default pack: holds the run until a condition passes or the user approves. The question card it opens and the `gate` pause type stay core's.
import type { Cond, Instr, NodeType, OpType } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface NodeKinds { gate: true }
  interface ModInstrs { GATE: { step: string; cond: Cond } }
  interface ModEvents { gate_paused: unknown }
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

export default function activate(api: Pick<ModApi, 'registerBlock'>): void {
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
    count: { gate_paused: () => 'gatesHeld' },
  };
  api.registerBlock(gate);
}
