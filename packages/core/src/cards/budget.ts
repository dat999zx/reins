import type { CardType } from './index.js';

declare module '../model.js' {
  interface CardKinds { budget: true }
}

const budget: CardType = { kind: 'budget' };
export default budget;
