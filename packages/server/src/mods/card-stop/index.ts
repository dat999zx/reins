// The `stop` card of the default pack: the run pauses and the text is shown to you (allowed only in a whenever block).
import type { CardType } from '@reins/core';
import type { ModApi } from '../types.js';

declare module '@reins/core' {
  interface CardKinds { stop: true }
}

export default function activate(api: Pick<ModApi, 'registerCard'>): void {
  const stop: CardType = { kind: 'stop', delivery: 'stop' };
  api.registerCard(stop);
}
