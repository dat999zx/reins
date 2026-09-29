import type { CondType } from '../cond.js';

declare module '../model.js' {
  interface CondAtoms { tests: { t: 'tests' } }
}

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
export default tests;
