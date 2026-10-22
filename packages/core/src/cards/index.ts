import type { Card, Diagnostic, Pos } from '../model.js';
import type { Policy } from '../compile.js';
import { ordered } from '../registry.js';
import guard from './guard.js';
import now from './now.js';
import stop from './stop.js';

export interface CardType {
  kind: string;
  turnLine?(card: Card): string;
  policy?(card: Card, policy: Policy): void;
  validate?(card: Card, ctx: { push(d: Diagnostic): void; pos: Pos }): void;
  delivery?: 'now' | 'stop';
}

const KINDS = ordered<CardType>('card', (c) => c.kind);
/** The cards in `order` (ties by arrival). Read it; add and remove with `registerCard`. */
export const CARDS = KINDS.map;

/** Adds a card at `order` (none: after every other). Throws on a known kind; with `shadow` it covers the known one instead. The disposer is one-shot. */
export function registerCard(c: CardType, order?: number, opts?: { shadow?: boolean }): () => void {
  return KINDS.add(c, { order, shadow: opts?.shadow });
}
// The numbers are today's order, with room between them.
for (const [c, order] of [[guard, 10], [now, 20], [stop, 30]] as const) registerCard(c, order);

export { default as guardCard } from './guard.js';
export { default as nowCard } from './now.js';
export { default as stopCard } from './stop.js';
