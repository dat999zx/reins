import type { CardType } from './index.js';

declare module '../model.js' {
  interface CardKinds { role: true }
}

const role: CardType = { kind: 'role' };
export default role;
