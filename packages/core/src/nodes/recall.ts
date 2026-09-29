import type { NodeType } from './index.js';

declare module '../model.js' {
  interface NodeKinds { recall: true }
}

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
};
export default recall;
