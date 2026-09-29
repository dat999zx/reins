import type { CondType } from '../cond.js';
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

export const CONDS = new Map<string, CondType>(
  [approve, tests, cmd, llm, review, done, diff, touches, attempts, same, drift].map((c) => [c.t, c]),
);

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
