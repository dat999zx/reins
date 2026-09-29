import picomatch from 'picomatch';
import type { CondType } from '../cond.js';
import { relPath } from '../policy.js';

declare module '../model.js' {
  interface CondAtoms { touches: { t: 'touches'; glob: string } }
}

const touches: CondType<{ t: 'touches'; glob: string }> = {
  t: 'touches',
  parse(s) {
    if (!s.src.startsWith('touches', s.idx)) return null;
    s.idx += 'touches'.length;
    s.skipWs();
    const globStart = s.idx;
    while (s.idx < s.len && !/\s|[)]/.test(s.src[s.idx]!)) {
      s.idx++;
    }
    if (globStart === s.idx) {
      return s.error('Expected glob pattern after "touches"', globStart);
    }
    const glob = s.src.slice(globStart, s.idx);
    return { t: 'touches', glob };
  },
  print(c) { return `touches ${c.glob}`; },
  judge: 'deterministic',
  globs(c) { return [c.glob]; },
  evalSync(c, ctx) {
    const isMatch = picomatch(c.glob);
    return ctx.events.some((ev) => {
      if (ev.type !== 'tool_call') return false;
      const p = ev.data?.input?.file_path || ev.data?.input?.path;
      return typeof p === 'string' && isMatch(relPath(p, ctx.cwd));
    });
  },
};
export default touches;
