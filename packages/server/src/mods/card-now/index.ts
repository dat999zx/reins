// The `now` card of the default pack: a note delivered to the agent in the middle of its turn (allowed only in a whenever block).
import type { CardType } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface CardKinds { now: true }
}

export default function activate(api: Pick<ModApi, 'registerCard'>): void {
  const now: CardType = { kind: 'now', delivery: 'now' };
  api.registerCard(now);
}
