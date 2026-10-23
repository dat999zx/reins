// The `recall` block of the default pack: asks the host for Knowl context on some topics; the next turn carries it. Its `recall` event is counted into the receipt's Knowl fields.
import type { Instr, NodeType, OpType } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface NodeKinds { recall: true }
  interface ModInstrs { RECALL: { step: string; topics: string[] } }
  interface ModEvents { recall: unknown }
}

const RECALL: OpType<Extract<Instr, { op: 'RECALL' }>> = {
  async exec(i, vm) {
    if (!vm.services.recall) {
      vm.setRecall([]);
      vm.log('recall', { topics: i.topics, skipped: 'no recall function' });
    } else {
      const context = await vm.services.recall(i.topics);
      vm.setRecall(context);
      vm.log('recall', { topics: i.topics, context });
    }
    vm.next();
  },
};

export default function activate(api: Pick<ModApi, 'registerBlock'>): void {
  const recall: NodeType = {
    kind: 'recall',
    attrs: ['knowl'],
    compile(step, ctx) {
      const knowl = step.attrs.knowl || '';
      const topics = knowl
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      ctx.push({ op: 'RECALL', step: step.id, topics });
    },
    ops: { RECALL },
    count: { recall: (d) => (d?.skipped ? 'knowlSkipped' : 'knowlRecalls') },
    print: { recall: (d) => (d.skipped ? '· recall skipped: Knowl is not wired up until Phase 6' : undefined) },
  };
  api.registerBlock(recall);
}
