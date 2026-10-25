// The `` `command` passes `` condition of the default pack: the command exits 0. `sameAsRun` lets a loop around a run block of that very command leave as soon as it passes.
import type { CondType } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface CondAtoms { cmd: { t: 'cmd'; cmd: string } }
}

export default function activate(api: Pick<ModApi, 'registerCondition'>): void {
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
  api.registerCondition(cmd);
}
