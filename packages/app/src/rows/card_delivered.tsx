import type { LogRow } from '@reins/server/store.js';

export const type = 'card_delivered';
export const render = (row: LogRow) => <div className="row"><span className="chip">card delivered ({(row.data as { channel: string }).channel})</span></div>;
