import type { LogRow } from '@reins/server/store.js';

export const type = 'step_started';
export const render = (row: LogRow) => <div className="divider sx-stepdiv">step {(row.data as { step: string }).step}</div>;
