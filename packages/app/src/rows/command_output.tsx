import type { LogRow } from '@reins/server/store.js';

export const type = 'command_output';
export const render = (row: LogRow) => {
  const chunk = (row.data as { chunk: string }).chunk;
  const text = chunk.trimEnd();
  return <details className="row output"><summary>{`output · ${text.slice(text.lastIndexOf('\n') + 1)}`}</summary><pre>{chunk}</pre></details>;
};
