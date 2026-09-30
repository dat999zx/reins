import type { LogRow } from '@reins/server/store.js';

export const type = 'run_started';
export const render = (row: LogRow) => <div className="divider">workflow {(row.data as { workflow: string }).workflow}</div>;
