import type { CondType } from '../cond.js';

declare module '../model.js' {
  interface CondAtoms { done: { t: 'done' } }
}

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
export default done;
