import type { NodeType } from './index.js';
import type { Instr } from '../compile.js';

declare module '../model.js' {
  interface NodeKinds { verify: true }
}

const verify: NodeType = {
  kind: 'verify',
  attrs: ['against'],
  tag: { place: 'after', lines: ['against: prompt'] },
  validate: {
    links(step, ctx) {
      if (step.attrs.against && !ctx.allIds.has(step.attrs.against)) {
        ctx.push({ severity: 'error', message: `verify against target "${step.attrs.against}" not found`, pos: ctx.pos });
      }
    },
  },
  defaultPrompt(step) {
    const target = step.attrs.against || 'plan';
    return `Compare what you built against step "${target}".\nList anything missing or extra.`;
  },
  statusLine: 'REINS: pass | fail: <what is missing>',
  compile(step, ctx) {
    const onFail = step.links.find((l) => l.kind === 'on-fail');
    const v = ctx.push<Extract<Instr, { op: 'VERIFY' }>>({ op: 'VERIFY', step: step.id, against: step.attrs.against || '', linkMax: onFail?.max });
    if (onFail) ctx.linkLater(v, onFail.to);
  },
};
export default verify;
