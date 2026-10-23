// packages/server/test-dist/check.ts: compiled against core's dist only (see tsconfig.dist-check.json)
import type { Cond, StepKind, CardKind } from '@reins/core';
export const c = { t: 'cmd', cmd: '' } satisfies Cond;
// Core registers no kind by name any more (M3): a block mod adds its own to NodeKinds, the way the default pack's mods do.
declare module '@reins/core' {
  interface NodeKinds { distcheck: true }
}
export const k = 'distcheck' satisfies StepKind;
export const g = 'guard' satisfies CardKind;
