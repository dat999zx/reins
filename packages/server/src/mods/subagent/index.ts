// The `subagent` block of the default pack: a step that runs in its own engine session, model and USD slice. It needs only `checkMode` from `api.core`.
// Core logs `subagent_started` and `subagent_result` itself (`subagentTurn` in run.ts), so they are not in `provides.events`; the manifest's view draws their rows.
import type { NodeType } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface NodeKinds { subagent: true }
}

export default function activate(api: Pick<ModApi, 'registerBlock' | 'core'>): void {
  const { checkMode } = api.core;
  // ponytail: one reply per pass (plus now-card follow-ups) and no inner steps; a pass after the subagent handed back starts a fresh one.
  const subagent: NodeType = {
    kind: 'subagent',
    attrs: ['model', 'reasoning', 'usd', 'mode'],
    sendsTurn: true,
    heading: {
      parse(arg, step) { step.title = arg; return false; },
      print(step) { return { text: step.title ? `subagent ${step.title}` : 'subagent', condInHeading: false }; },
    },
    validate: {
      early: checkMode,
      late(step, ctx) {
        if (!step.prompt?.trim()) ctx.push({ severity: 'warning', message: `Subagent step "${step.id}" has no prompt`, pos: ctx.pos });
      },
    },
    compile(step, ctx) { ctx.push({ op: 'NODE', step: step.id, kind: 'subagent', src: step }); },
    async exec(step, ctx) {
      return (await ctx.subagent(step, step.attrs.usd === undefined ? undefined : Number(step.attrs.usd))) ? 'next' : 'stay';
    },
  };
  api.registerBlock(subagent);
}
