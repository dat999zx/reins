import type { NodeType } from './index.js';
import { checkMode } from './turn.js';

declare module '../model.js' {
  interface NodeKinds { subagent: true }
}

// ponytail: one reply per pass (plus now-card follow-ups) and no inner steps; a pass after the subagent handed back starts a fresh one.
const subagent: NodeType = {
  kind: 'subagent',
  attrs: ['model', 'usd', 'mode'],
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
export default subagent;
