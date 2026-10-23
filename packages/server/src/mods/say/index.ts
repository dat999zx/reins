// The `say` block of the default pack: a turn with the step's own prompt. It needs only `checkMode` and `turnInstr` from `api.core`.
import type { NodeType } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface NodeKinds { say: true }
}

export default function activate(api: Pick<ModApi, 'registerBlock' | 'core'>): void {
  const { checkMode, turnInstr } = api.core;
  const say: NodeType = {
    kind: 'say',
    attrs: ['mode'],
    validate: { early: checkMode },
    compile(step, ctx) { ctx.push(turnInstr(step)); },
  };
  api.registerBlock(say);
}
