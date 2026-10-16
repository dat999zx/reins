import type { NodeType, OpType } from './index.js';
import type { Instr } from '../compile.js';

declare module '../model.js' {
  interface NodeKinds { recall: true }
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
};
export default recall;
