import type { NodeType } from './index.js';

declare module '../model.js' {
  interface NodeKinds { end: true }
}

// ponytail: the turn header's "step N of M" counts every top-level step, the end and free blocks included (run.ts); an end inside a block used by `use` ends the calling workflow.
const end: NodeType = {
  kind: 'end',
  attrs: [],
  validate: {
    early(s, ctx) {
      if (s.links.length || s.cards.length || s.prompt) {
        ctx.push({ severity: 'warning', message: 'an end step stops the workflow; its links, cards and prompt do nothing', pos: ctx.pos });
      }
    },
  },
  compile(_s, ctx) { ctx.push({ op: 'END' }); },
};
export default end;