import type { NodeType } from './index.js';
import type { Instr } from '../compile.js';

declare module '../model.js' {
  interface NodeKinds { run: true }
}

const run: NodeType = {
  kind: 'run',
  fails: true,
  attrs: ['cmd'],
  heading: {
    owns: ['cmd'],
    parse(arg, step) {
      let cmd = arg;
      if (cmd.startsWith('`') && cmd.endsWith('`')) {
        cmd = cmd.slice(1, -1);
      }
      step.attrs.cmd = cmd;
      return false;
    },
    print(step) { return { text: step.attrs.cmd ? `run \`${step.attrs.cmd}\`` : 'run', condInHeading: false }; },
  },
  compile(step, ctx) {
    const onFail = step.links.find((l) => l.kind === 'on-fail');
    // ponytail: a jump out of a repeat child skips LOOP_BK, so the loop's max does not count it; only the link budget limits it
    const r = ctx.push<Extract<Instr, { op: 'RUN' }>>({
      op: 'RUN',
      step: step.id,
      cmd: step.attrs.cmd || '',
      ...(onFail?.max !== undefined ? { linkMax: onFail.max } : {}),
    });
    if (onFail) ctx.linkLater(r, onFail.to);
  },
};
export default run;
