// The `diff > N lines` condition of the default pack: the change in the work folder is longer than N lines.
import type { CondType } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface CondAtoms { diff: { t: 'diff'; n: number } }
}

export default function activate(api: Pick<ModApi, 'registerCondition'>): void {
  const diff: CondType<{ t: 'diff'; n: number }> = {
    t: 'diff',
    parse(s) {
      if (!s.src.startsWith('diff', s.idx)) return null;
      s.idx += 'diff'.length;
      s.skipWs();
      if (s.idx >= s.len || s.src[s.idx] !== '>') {
        return s.error('Expected ">" after diff', s.idx);
      }
      s.idx++; // skip >
      s.skipWs();
      const numStart = s.idx;
      while (s.idx < s.len && /[0-9]/.test(s.src[s.idx]!)) {
        s.idx++;
      }
      if (numStart === s.idx) {
        return s.error('Expected integer after "diff >"', numStart);
      }
      const n = parseInt(s.src.slice(numStart, s.idx), 10);
      s.skipWs();
      if (!s.src.startsWith('lines', s.idx)) {
        return s.error('Expected "lines" after diff count', s.idx);
      }
      s.idx += 'lines'.length;
      return { t: 'diff', n };
    },
    print(c) { return `diff > ${c.n} lines`; },
    judge: 'deterministic',
    async evaluate(c, ctx) {
      if (!ctx.diffLines) return false;
      const lines = await ctx.diffLines();
      return lines > c.n;
    },
  };
  api.registerCondition(diff);
}
