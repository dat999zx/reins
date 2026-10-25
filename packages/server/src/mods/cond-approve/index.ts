// The `you approve` condition of the default pack: true when the person approves at a pause. Judged by you, never inside an auto card.
import type { CondType } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface CondAtoms { approve: { t: 'approve' } }
}

export default function activate(api: Pick<ModApi, 'registerCondition'>): void {
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
  api.registerCondition(approve);
}
