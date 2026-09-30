import type { LogRow } from '@reins/server/store.js';

export const type = 'cards_unsent';
export const render = (row: LogRow) => {
  const n = (row.data as { cards: string[] }).cards.length;
  return <div className="row muted">{n} card{n === 1 ? ' was' : 's were'} not sent; they go back into the input box.</div>;
};
