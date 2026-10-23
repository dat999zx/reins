// The `end` block of the default pack: it stops the workflow. It is required. The `END` instruction itself is core's (a program always closes with one).
import type { NodeType } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface NodeKinds { end: true }
}

export default function activate(api: Pick<ModApi, 'registerBlock'>): void {
  // ponytail: the turn header's "step N of M" counts every top-level step, the end and free blocks included (run.ts); an end inside a playbook ends only the playbook (the playbook jumps to its own close).
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
  api.registerBlock(end);
}
