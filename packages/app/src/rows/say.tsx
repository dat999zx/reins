import type { LogRow } from '@reins/server/store.js';

export const type = 'say';
export const render = (row: LogRow) => <div className="row mono">{(row.data as { text: string }).text}</div>;
