import type { Card, Diagnostic, Pos } from '../model.js';
import type { Policy } from '../compile.js';
import { ordered } from '../registry.js';

/** The words the block panel uses for a card kind: its section title and its add button. Plain data. */
export interface CardView { section: string; add: string }

export interface CardType {
  kind: string;
  /** The panel's words for this card. For a mod (the pack's too) it comes from the manifest. A card with none is not offered. */
  view?: CardView;
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
