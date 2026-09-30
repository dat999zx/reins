import type { LogRow } from '@reins/server/store.js';

export const type = 'card_queued';
export const render = (row: LogRow) => {
  const d = row.data as { card: string; kind: string };
  return <div className="row"><span className="chip">{d.kind} card</span> {d.card}</div>;
};
