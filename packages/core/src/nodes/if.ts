import type { NodeType } from './index.js';
import { parseCond, printCond } from '../cond.js';

declare module '../model.js' {
  interface NodeKinds { if: true }
}

const ifNode: NodeType = {
  kind: 'if',
  attrs: [],
  container: 'kids+else',
  heading: {
    parse(arg, step, ctx) {
      const r = parseCond(arg, { line: ctx.line, col: ctx.col });
      if (r.diag) ctx.push(r.diag);
      if (r.cond) step.cond = r.cond;
      return true;
    },
    print(step) { return { text: step.cond ? `if ${printCond(step.cond)}` : 'if', condInHeading: true }; },
  },
  compile(step, ctx) {
    const ifInstr = ctx.push({ op: 'IF', step: step.id, cond: step.cond || { t: 'done' }, elseJump: 0 });

    if (step.kids) ctx.compile(step.kids);

    if (step.else && step.else.length > 0) {
      const jumpEnd = ctx.push({ op: 'JUMP', target: 0 });
      ifInstr.elseJump = ctx.at();
      ctx.compile(step.else);
      jumpEnd.target = ctx.at();
    } else {
      ifInstr.elseJump = ctx.at();
    }
  },
};
export default ifNode;
