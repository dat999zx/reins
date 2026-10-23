// The `drift` condition of the default pack: any of the live drift signals fires. The detectors stay in core (the run uses them too); `driftFound` comes from `api.core`.
import type { CondType } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface CondAtoms { drift: { t: 'drift' } }
}

export default function activate(api: Pick<ModApi, 'registerCondition' | 'core'>): void {
  const { driftFound } = api.core;
  const drift: CondType<{ t: 'drift' }> = {
    t: 'drift',
    parse(s) {
      if (!s.src.startsWith('drift', s.idx)) return null;
      s.idx += 'drift'.length;
      return { t: 'drift' };
    },
    print() { return 'drift'; },
    judge: 'deterministic',
    evalSync(_c, ctx) { return driftFound(ctx.events); },
  };
  api.registerCondition(drift);
}
