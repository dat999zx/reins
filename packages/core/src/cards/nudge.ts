import type { CardType } from './index.js';

declare module '../model.js' {
  interface CardKinds { nudge: true }
}

const nudge: CardType = { kind: 'nudge' };
export default nudge;
