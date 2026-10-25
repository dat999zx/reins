import type { LogRow } from '@reins/server/store.js';

export const type = 'budget_warning';
export const render = (row: LogRow) => <div className="row bad">{String((row.data as { text?: unknown } | null)?.text ?? '')}</div>;
