import type { CardType } from './index.js';

declare module '../model.js' {
  interface CardKinds { now: true }
}

const now: CardType = { kind: 'now', delivery: 'now' };
export default now;
