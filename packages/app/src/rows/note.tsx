import type { LogRow } from '@reins/server/store.js';

export const type = 'note';
export const render = (row: LogRow) => <div className="row muted italic">{(row.data as { text: string }).text}</div>;
