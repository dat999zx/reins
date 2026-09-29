import type { CondType } from '../cond.js';

declare module '../model.js' {
  interface CondAtoms { same: { t: 'same' } }
}

const same: CondType<{ t: 'same' }> = {
  t: 'same',
  parse(s) {
    if (!s.src.startsWith('same error twice', s.idx)) return null;
    s.idx += 'same error twice'.length;
    return { t: 'same' };
  },
  print() { return 'same error twice'; },
  judge: 'deterministic',
  evalSync(_c, ctx) {
    const len = ctx.commandResults.length;
    if (len < 2) return false;
    const last1 = ctx.commandResults[len - 1]!;
    const last2 = ctx.commandResults[len - 2]!;
    if (last1.exitCode === 0 || last2.exitCode === 0) return false;
    const norm = (s: string) => s.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
    return norm(last1.output) === norm(last2.output);
  },
};
export default same;
