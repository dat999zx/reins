import type { LogRow } from '@reins/server/store.js';
import type { CardState } from '../feed.js';
import type { Ctx } from '../rows.js';

export const type = 'card_queued';
// what happened to a card; the feed works it out from the deliveries (feed.ts), this only words it
export const CARD_WORDS: Record<CardState['state'], string> =
  { queued: 'queued', 'mid-turn': 'card delivered (mid-turn)', 'next-turn': 'delivered with the next turn', interrupt: 'delivered now', unsent: 'not sent' };

export const render = (row: LogRow, ctx?: Ctx) => {
  const d = row.data as { card: string; kind: string };
  const c = ctx?.card?.get(row.seq);
  const words = c && CARD_WORDS[c.state] ? `${CARD_WORDS[c.state]}${c.landed ? ` · in ${c.landed}` : ''}` : '';
  return <div className="row"><span className="chip">{d.kind} card</span> {d.card}{words && <span className="muted"> · {words}</span>}</div>;
};
