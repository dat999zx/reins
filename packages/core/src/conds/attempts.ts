import type { CondType } from '../cond.js';

declare module '../model.js' {
  interface CondAtoms { attempts: { t: 'attempts'; n: number } }
}

const attempts: CondType<{ t: 'attempts'; n: number }> = {
  t: 'attempts',
  parse(s) {
    if (!s.src.startsWith('attempts', s.idx)) return null;
    s.idx += 'attempts'.length;
    s.skipWs();
    if (s.idx >= s.len || s.src[s.idx] !== '>') {
      return s.error('Expected ">" after attempts', s.idx);
    }
    s.idx++; // skip >
    s.skipWs();
    const numStart = s.idx;
    while (s.idx < s.len && /[0-9]/.test(s.src[s.idx]!)) {
      s.idx++;
    }
    if (numStart === s.idx) {
      return s.error('Expected integer after "attempts >"', numStart);
    }
    const n = parseInt(s.src.slice(numStart, s.idx), 10);
    return { t: 'attempts', n };
  },
  print(c) { return `attempts > ${c.n}`; },
  judge: 'deterministic',
  evalSync(c, ctx) { return ctx.loopTotal > c.n; },
};
export default attempts;
