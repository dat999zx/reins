import type { NodeType } from './index.js';

declare module '../model.js' {
  interface NodeKinds { store: true }
}

const store: NodeType = {
  kind: 'store',
  attrs: ['knowl'],
  compile(step, ctx) { ctx.push({ op: 'STORE', step: step.id, what: step.attrs.knowl || 'decisions' }); },
};
export default store;
