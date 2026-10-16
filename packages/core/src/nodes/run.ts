import type { NodeType, OpType } from './index.js';
import type { Instr } from '../compile.js';

declare module '../model.js' {
  interface NodeKinds { run: true }
}

const RUN: OpType<Extract<Instr, { op: 'RUN' }>> = {
  async exec(i, vm) {
    const cmdRes = await vm.command(i.cmd);
    vm.log('command_result', { step: i.step, exitCode: cmdRes.exitCode });

    if (cmdRes.exitCode === 0) {
      if (i.repeatCond && i.loopExit !== undefined) {
        const passed = await vm.judge(i.repeatCond);
        if (!vm.running()) return;
        if (passed) {
          vm.goto(i.loopExit);
          return;
        }
      }
      if (i.onPassJump !== undefined) {
        vm.goto(i.onPassJump);
      } else {
        vm.next();
      }
    } else {
      if (i.onFailJump !== undefined) {
        if (!vm.takeLink(`${i.step}->${i.onFailJump}`, i.onFailJump, i.linkMax)) {
          return;
        }
        vm.goto(i.onFailJump);
      } else {
        vm.next();
      }
    }
  },
  next: (i, at) => [at + 1, i.onFailJump, i.onPassJump, i.loopExit],
  commands: (i) => [i.cmd],
};

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
  ops: { RUN },
};
export default run;
