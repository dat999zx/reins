import type { Card, Diagnostic, Pos } from '../model.js';
import type { Policy } from '../compile.js';
import guard from './guard.js';
import note from './note.js';
import nudge from './nudge.js';
import role from './role.js';
import checkpoint from './checkpoint.js';
import budget from './budget.js';
import undo from './undo.js';
import now from './now.js';
import stop from './stop.js';

export interface CardType {
  kind: string;
  turnLine?(card: Card): string;
  policy?(card: Card, policy: Policy): void;
  validate?(card: Card, ctx: { push(d: Diagnostic): void; pos: Pos }): void;
  delivery?: 'now' | 'stop';
}

export const CARDS = new Map<string, CardType>(
  [guard, note, nudge, role, checkpoint, budget, undo, now, stop].map((c) => [c.kind, c]),
);

export { default as guardCard } from './guard.js';
export { default as noteCard } from './note.js';
export { default as nudgeCard } from './nudge.js';
export { default as roleCard } from './role.js';
export { default as checkpointCard } from './checkpoint.js';
export { default as budgetCard } from './budget.js';
export { default as undoCard } from './undo.js';
export { default as nowCard } from './now.js';
export { default as stopCard } from './stop.js';
