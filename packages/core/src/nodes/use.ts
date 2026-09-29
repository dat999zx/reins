import type { NodeType } from './index.js';
import type { Step } from '../model.js';

declare module '../model.js' {
  interface NodeKinds { use: true }
}

function prefixStep(step: Step, prefix: string): Step {
  const copy: Step = {
    ...step,
    id: `${prefix}/${step.id}`,
    links: step.links.map((l) => ({
      ...l,
      to: `${prefix}/${l.to}`,
    })),
  };
  if (step.kids) {
    copy.kids = step.kids.map((k) => prefixStep(k, prefix));
  }
  if (step.else) {
    copy.else = step.else.map((k) => prefixStep(k, prefix));
  }
  return copy;
}

const use: NodeType = {
  kind: 'use',
  attrs: [],
  heading: {
    owns: ['use'],
    parse(arg, step) { step.title = arg; step.attrs.use = arg; return false; },
    print(step) { return { text: `use ${step.title || step.attrs.use || step.id}`, condInHeading: false }; },
  },
  validate: {
    early(step, ctx) {
      const blockName = step.title || step.attrs.use || step.id;
      if (ctx.resolveBlock) {
        const resolved = ctx.resolveBlock(blockName);
        if (!resolved) {
          ctx.push({ severity: 'error', message: `Block "${blockName}" not found`, pos: ctx.pos });
        }
      }
    },
  },
  compile(step, ctx) {
    const blockName = step.title || step.attrs.use || step.id;
    const block = ctx.resolveBlock ? ctx.resolveBlock(blockName) : undefined;
    if (block) {
      for (const bStep of block.steps) {
        const prefixed = prefixStep(bStep, blockName);
        ctx.compile([prefixed]);
      }
    }
  },
};
export default use;
