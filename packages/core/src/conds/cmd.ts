import type { CondType } from '../cond.js';

declare module '../model.js' {
  interface CondAtoms { cmd: { t: 'cmd'; cmd: string } }
}

const cmd: CondType<{ t: 'cmd'; cmd: string }> = {
  t: 'cmd',
  parse(s) {
    if (s.src[s.idx] !== '`') return null;
    s.idx++;
    let cmd = '';
    while (s.idx < s.len && s.src[s.idx] !== '`') {
      cmd += s.src[s.idx];
      s.idx++;
    }
    if (s.idx >= s.len) {
      return s.error('Unterminated command', s.idx);
    }
    s.idx++; // skip `
    s.skipWs();
    if (!s.src.startsWith('passes', s.idx)) {
      return s.error('Expected "passes" after command', s.idx);
    }
    s.idx += 'passes'.length;
    return { t: 'cmd', cmd };
  },
  print(c) { return `\`${c.cmd}\` passes`; },
  judge: 'command',
  view: { label: 'command passes', fresh: { t: 'cmd', cmd: 'npm run lint' }, param: { key: 'cmd', look: 'code' } },
  auto: false,
  sameAsRun: (c, cmd) => c.cmd === cmd,
  async evaluate(c, ctx) {
    const last = ctx.commandResults[ctx.commandResults.length - 1];
    if (
      last &&
      last.cmd === c.cmd &&
      last.exitCode === 0 &&
      ctx.atRun
    ) {
      return true;
    }
    const res = await ctx.runCommand(c.cmd);
    return res.exitCode === 0;
  },
};
export default cmd;
