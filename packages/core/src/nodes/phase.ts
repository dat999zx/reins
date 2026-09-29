import type { NodeType } from './index.js';
import { turnInstr } from './turn.js';
import { slugify } from '../util.js';

declare module '../model.js' {
  interface NodeKinds { phase: true }
}

const phase: NodeType = {
  kind: 'phase',
  attrs: ['mode'],
  heading: {
    parse(arg, step) { step.title = arg; return false; },
    print(step) { return { text: step.title ? `phase ${step.title}` : 'phase', condInHeading: false }; },
  },
  defaultId(step) { return step.title ? slugify(step.title) || undefined : undefined; },
  validate: {
    late(step, ctx) {
      if (!step.prompt || step.prompt.trim() === '') {
        ctx.push({ severity: 'warning', message: `Phase step "${step.id}" has no prompt`, pos: ctx.pos });
      }
    },
  },
  compile(step, ctx) { ctx.push(turnInstr(step)); },
};
export default phase;
