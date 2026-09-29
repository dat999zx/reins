import type { CondType } from '../cond.js';

declare module '../model.js' {
  interface CondAtoms { review: { t: 'review'; q?: string } }
}

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
export default review;
