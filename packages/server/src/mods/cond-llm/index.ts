// The `llm says "..."` condition of the default pack: a model answers the question. No judge means "no", everywhere (gate, repeat, if).
import type { CondType } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface CondAtoms { llm: { t: 'llm'; q: string } }
}

export default function activate(api: Pick<ModApi, 'registerCondition'>): void {
  const llm: CondType<{ t: 'llm'; q: string }> = {
    t: 'llm',
    parse(s) {
      if (!s.src.startsWith('llm says', s.idx)) return null;
      s.idx += 'llm says'.length;
      const qRes = s.quoted();
      if (qRes.diag) return { diag: qRes.diag };
      return { t: 'llm', q: qRes.val! };
    },
    print(c) { return `llm says "${c.q}"`; },
    judge: 'model',
    auto: false,
    modelCall: 'llm says',
    async evaluate(c, ctx) {
      // Plan 7.3: no judge means "no", everywhere (gate, repeat, if). Never pass by default.
      if (!ctx.judge) return false;
      const answer = await ctx.judge(c, { lastText: ctx.lastTurnText ?? '' });
      ctx.logEvent('judge', { cond: c, answer });
      return answer;
    },
  };
  api.registerCondition(llm);
}
