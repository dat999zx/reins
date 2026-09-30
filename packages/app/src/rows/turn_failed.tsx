import type { LogRow } from '@reins/server/store.js';

export const type = 'turn_failed';
export const render = (row: LogRow) => <div className="row bad">turn failed: {(row.data as { error: string }).error}</div>;
