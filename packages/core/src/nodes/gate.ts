import type { NodeType } from './index.js';

declare module '../model.js' {
  interface NodeKinds { gate: true }
}

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
};
export default gate;
