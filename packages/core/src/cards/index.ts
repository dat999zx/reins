import type { Card, Diagnostic, Pos } from '../model.js';
import type { Policy } from '../compile.js';
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

export const CARDS = new Map<string, CardType>(
  [guard, now, stop].map((c) => [c.kind, c]),
);

export { default as guardCard } from './guard.js';
export { default as nowCard } from './now.js';
export { default as stopCard } from './stop.js';
