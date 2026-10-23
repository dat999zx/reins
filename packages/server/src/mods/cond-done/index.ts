// The `agent says done` condition of the default pack: the agent's last line is `REINS: done`.
import type { CondType } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface CondAtoms { done: { t: 'done' } }
}

export default function activate(api: Pick<ModApi, 'registerCondition'>): void {
  const done: CondType<{ t: 'done' }> = {
    t: 'done',
    parse(s) {
      if (!s.src.startsWith('agent says done', s.idx)) return null;
      s.idx += 'agent says done'.length;
      return { t: 'done' };
    },
    print() { return 'agent says done'; },
    judge: 'agent',
    evalSync(_c, ctx) {
      if (!ctx.lastTurnText) return false;
      const lastLine = ctx.lastTurnText.trim().split(/\r?\n/).pop()?.trim();
      return lastLine === 'REINS: done';
    },
  };
  api.registerCondition(done);
}
