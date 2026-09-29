import type { CardType } from './index.js';

declare module '../model.js' {
  interface CardKinds { note: true }
}

const note: CardType = {
  kind: 'note',
  turnLine(card) { return card.text; },
};
export default note;
