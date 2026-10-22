import type { CondType } from '../cond.js';
import { ordered } from '../registry.js';
import approve from './approve.js';
import tests from './tests.js';
import cmd from './cmd.js';
import llm from './llm.js';
import review from './review.js';
import done from './done.js';
import diff from './diff.js';
import touches from './touches.js';
import attempts from './attempts.js';
import same from './same.js';
import drift from './drift.js';

const ATOMS = ordered<CondType>('condition', (c) => c.t);
/** The atoms in `order` (ties by arrival); the parser tries them in this order. Read it; add and remove with `registerCondition`. */
export const CONDS = ATOMS.map;

/** Adds an atom at `order` (none: after every other). Throws on a known `t`; with `shadow` it covers the known one instead. The disposer is one-shot. */
export function registerCondition(c: CondType, order?: number, opts?: { shadow?: boolean }): () => void {
  return ATOMS.add(c, { order, shadow: opts?.shadow });
}

const BUILT_IN = new Set<CondType>();
// The numbers are today's order, with room between them.
for (const [c, order] of [[approve, 10], [tests, 20], [cmd, 30], [llm, 40], [review, 50], [done, 60], [diff, 70], [touches, 80], [attempts, 90], [same, 100], [drift, 110]] as const) {
  BUILT_IN.add(c);
  registerCondition(c, order);
}
/** True for any atom that did not come with core: the parser holds back its diagnostic until no other atom matches. */
export function isModCond(c: CondType): boolean { return !BUILT_IN.has(c); }

export { default as approveCond } from './approve.js';
export { default as testsCond } from './tests.js';
export { default as cmdCond } from './cmd.js';
export { default as llmCond } from './llm.js';
export { default as reviewCond } from './review.js';
export { default as doneCond } from './done.js';
export { default as diffCond } from './diff.js';
export { default as touchesCond } from './touches.js';
export { default as attemptsCond } from './attempts.js';
export { default as sameCond } from './same.js';
export { default as driftCond } from './drift.js';
