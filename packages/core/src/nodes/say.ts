import type { NodeType } from './index.js';
import { checkMode, turnInstr } from './turn.js';

declare module '../model.js' {
  interface NodeKinds { say: true }
}

const say: NodeType = {
  kind: 'say',
  attrs: ['mode'],
  validate: { early: checkMode },
  compile(step, ctx) { ctx.push(turnInstr(step)); },
};
export default say;
