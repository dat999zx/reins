import type { NodeType } from './index.js';

declare module '../model.js' {
  interface NodeKinds { run: true }
}

const run: NodeType = {
  kind: 'run',
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
  compile(step, ctx) { ctx.push({ op: 'RUN', step: step.id, cmd: step.attrs.cmd || '' }); },
};
export default run;
