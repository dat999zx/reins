import type { LogRow } from '@reins/server/store.js';

export const type = 'command_output';
export const render = (row: LogRow) => <pre className="row output">{(row.data as { chunk: string }).chunk}</pre>;
