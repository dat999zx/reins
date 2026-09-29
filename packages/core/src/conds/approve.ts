import type { CondType } from '../cond.js';

declare module '../model.js' {
  interface CondAtoms { approve: { t: 'approve' } }
}

const approve: CondType<{ t: 'approve' }> = {
  t: 'approve',
  parse(s) {
    if (!s.src.startsWith('you approve', s.idx)) return null;
    s.idx += 'you approve'.length;
    return { t: 'approve' };
  },
  print() { return 'you approve'; },
  judge: 'you',
  auto: false,
};
export default approve;
