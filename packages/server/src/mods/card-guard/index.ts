// The `guard` card of the default pack: a glob the agent may not touch. The policy blocks the edit; the turn line says so. It needs `isValidGlob` from `api.core`.
import type { CardType } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface CardKinds { guard: true }
}

export default function activate(api: Pick<ModApi, 'registerCard' | 'core'>): void {
  const { isValidGlob } = api.core;
  const guard: CardType = {
    kind: 'guard',
    turnLine(card) { return `Do not touch ${card.text}. (Enforced: edits there are blocked.)`; },
    policy(card, policy) { policy.guards.push(card.text); },
    validate(card, ctx) {
      if (!isValidGlob(card.text)) ctx.push({ severity: 'error', message: `Invalid glob "${card.text}" in guard`, pos: card.pos || ctx.pos });
    },
  };
  api.registerCard(guard);
}
