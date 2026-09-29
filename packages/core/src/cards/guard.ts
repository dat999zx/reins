import type { CardType } from './index.js';
import { isValidGlob } from '../util.js';

declare module '../model.js' {
  interface CardKinds { guard: true }
}

const guard: CardType = {
  kind: 'guard',
  turnLine(card) { return `Do not touch ${card.text}. (Enforced: edits there are blocked.)`; },
  policy(card, policy) { policy.guards.push(card.text); },
  validate(card, ctx) {
    if (!isValidGlob(card.text)) ctx.push({ severity: 'error', message: `Invalid glob "${card.text}" in guard`, pos: card.pos || ctx.pos });
  },
};
export default guard;
