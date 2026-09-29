import type { CardType } from './index.js';

declare module '../model.js' {
  interface CardKinds { stop: true }
}

const stop: CardType = { kind: 'stop', delivery: 'stop' };
export default stop;
