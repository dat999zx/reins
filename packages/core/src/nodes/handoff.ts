import type { NodeType } from './index.js';

declare module '../model.js' {
  interface NodeKinds { handoff: true }
}

const handoff: NodeType = {
  kind: 'handoff',
  attrs: ['to', 'focus'],
  compile(step, ctx) {
    ctx.push({
      op: 'HANDOFF',
      step: step.id,
      to: step.attrs.to || 'fresh session',
      ...(step.attrs.focus ? { focus: step.attrs.focus } : {}),
    });
  },
};
export default handoff;
