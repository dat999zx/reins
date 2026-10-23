// The `reviewer approves` condition of the default pack: a reviewer subagent answers (the question is optional). No judge means "no", everywhere (gate, repeat, if).
import type { CondType } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface CondAtoms { review: { t: 'review'; q?: string } }
}

export default function activate(api: Pick<ModApi, 'registerCondition'>): void {
  const review: CondType<{ t: 'review'; q?: string }> = {
    t: 'review',
    parse(s) {
      if (!s.src.startsWith('reviewer approves', s.idx)) return null;
      s.idx += 'reviewer approves'.length;
      s.skipWs();
      if (s.idx < s.len && (s.src[s.idx] === '"' || s.src[s.idx] === "'")) {
        const qRes = s.quoted();
        if (qRes.diag) return { diag: qRes.diag };
        return { t: 'review', q: qRes.val };
      }
      return { t: 'review' };
    },
    print(c) { return c.q ? `reviewer approves "${c.q}"` : 'reviewer approves'; },
    judge: 'subagent',
    auto: false,
    modelCall: 'reviewer approves',
    async evaluate(c, ctx) {
      // Plan 7.3: no judge means "no", everywhere (gate, repeat, if). Never pass by default.
      if (!ctx.judge) return false;
      const answer = await ctx.judge(c, { lastText: ctx.lastTurnText ?? '' });
      ctx.logEvent('judge', { cond: c, answer });
      return answer;
    },
  };
  api.registerCondition(review);
}
