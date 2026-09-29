import type { CondType } from '../cond.js';
import { repeatedAction, stagnation, editBeforePlan, sameError } from '../drift.js';

declare module '../model.js' {
  interface CondAtoms { drift: { t: 'drift' } }
}

const drift: CondType<{ t: 'drift' }> = {
  t: 'drift',
  parse(s) {
    if (!s.src.startsWith('drift', s.idx)) return null;
    s.idx += 'drift'.length;
    return { t: 'drift' };
  },
  print() { return 'drift'; },
  judge: 'deterministic',
  evalSync(_c, ctx) {
    return (
      repeatedAction(ctx.events) !== null ||
      stagnation(ctx.events) !== null ||
      editBeforePlan(ctx.events) !== null ||
      sameError(ctx.events) !== null
    );
  },
};
export default drift;
