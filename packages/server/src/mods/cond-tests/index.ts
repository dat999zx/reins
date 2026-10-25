// The `tests pass` condition of the default pack: the workflow's test command (or `npm test`) exits 0. `sameAsRun` lets a loop around a run block of that
// very command leave as soon as it passes.
import type { CondType } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface CondAtoms { tests: { t: 'tests' } }
}

export default function activate(api: Pick<ModApi, 'registerCondition'>): void {
  const tests: CondType<{ t: 'tests' }> = {
    t: 'tests',
    parse(s) {
      if (!s.src.startsWith('tests pass', s.idx)) return null;
      s.idx += 'tests pass'.length;
      return { t: 'tests' };
    },
    print() { return 'tests pass'; },
    judge: 'command',
    auto: false,
    needsTestCmd: true,
    sameAsRun: (_c, cmd) => cmd === 'npm test' || !cmd,
    async evaluate(_c, ctx) {
      const cmd = ctx.testCmd;
      const last = ctx.commandResults[ctx.commandResults.length - 1];
      if (
        last &&
        last.cmd === cmd &&
        last.exitCode === 0 &&
        ctx.atRun
      ) {
        return true;
      }
      const res = await ctx.runCommand(cmd);
      return res.exitCode === 0;
    },
  };
  api.registerCondition(tests);
}
