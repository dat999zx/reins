import type { CardType } from './index.js';

declare module '../model.js' {
  interface CardKinds { checkpoint: true }
}

const checkpoint: CardType = { kind: 'checkpoint' };
export default checkpoint;
