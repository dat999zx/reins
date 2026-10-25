// packages/server/test-dist/check.ts: compiled against core's dist only (see tsconfig.dist-check.json)
import type { Cond, StepKind, CardKind } from '@reins/core';
// Core registers no kind, condition or card by name any more (M3): a mod adds its own to NodeKinds, CondAtoms and CardKinds, the way the default pack's mods do.
// A consumer compiled against core's dist alone must be able to do the same.
declare module '@reins/core' {
  interface NodeKinds { distcheck: true }
  interface CondAtoms { distcond: { t: 'distcond'; arg: string } }
  interface CardKinds { distcard: true }
}
export const k = 'distcheck' satisfies StepKind;
export const c = { t: 'distcond', arg: '' } satisfies Cond;
export const g = 'distcard' satisfies CardKind;
