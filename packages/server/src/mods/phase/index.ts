// The `phase` block of the default pack: a titled turn. It is required: a chat turn is built on it (`chatTurn`), and a workflow with no turn block
// cannot ask the engine anything. Its folder holds its own id helper, so it needs only `checkMode` and `turnInstr` from `api.core`.
import type { NodeType } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface NodeKinds { phase: true }
}

/** The same slug core's parser makes ids with (`util.ts`): lower case, runs of anything else become one dash, none at the ends. */
const slugify = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export default function activate(api: Pick<ModApi, 'registerBlock' | 'core'>): void {
  const { checkMode, turnInstr } = api.core;
  const phase: NodeType = {
    kind: 'phase',
    attrs: ['mode'],
    // The kind a chat message is wrapped in (the tags of the chat build `## phase prompt`).
    chatTurn: true,
    heading: {
      parse(arg, step) { step.title = arg; return false; },
      print(step) { return { text: step.title ? `phase ${step.title}` : 'phase', condInHeading: false }; },
    },
    defaultId(step) { return step.title ? slugify(step.title) || undefined : undefined; },
    validate: {
      early: checkMode,
      late(step, ctx) {
        if (!step.prompt || step.prompt.trim() === '') {
          ctx.push({ severity: 'warning', message: `Phase step "${step.id}" has no prompt`, pos: ctx.pos });
        }
      },
    },
    compile(step, ctx) { ctx.push(turnInstr(step)); },
  };
  api.registerBlock(phase);
}
