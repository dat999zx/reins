import type { CardType } from './index.js';

declare module '../model.js' {
  interface CardKinds { undo: true }
}

const undo: CardType = { kind: 'undo' };
export default undo;
