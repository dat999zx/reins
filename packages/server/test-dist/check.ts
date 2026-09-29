// packages/server/test-dist/check.ts: compiled against core's dist only (see tsconfig.dist-check.json)
import type { Cond, StepKind, CardKind } from '@reins/core';
export const c = { t: 'cmd', cmd: '' } satisfies Cond;
export const k = 'phase' satisfies StepKind;
export const g = 'guard' satisfies CardKind;
