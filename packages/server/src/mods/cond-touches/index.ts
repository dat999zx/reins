// The `touches <glob>` condition of the default pack: a tool call named a file the glob matches. It needs `globMatcher` and `relPath` from `api.core`
// (a mod may not import the glob package or a core file).
import type { CondType } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface CondAtoms { touches: { t: 'touches'; glob: string } }
}

export default function activate(api: Pick<ModApi, 'registerCondition' | 'core'>): void {
  const { globMatcher, relPath } = api.core;
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
      const isMatch = globMatcher(c.glob);
      return ctx.events.some((ev) => {
        if (ev.type !== 'tool_call') return false;
        const p = ev.data?.input?.file_path || ev.data?.input?.path;
        return typeof p === 'string' && isMatch(relPath(p, ctx.cwd));
      });
    },
  };
  api.registerCondition(touches);
}
