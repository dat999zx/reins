import type { LogRow } from '@reins/server/store.js';

export const type = 'turn_ended';
export const render = (row: LogRow) => {
  const cost = (row.data as { cost?: number } | null)?.cost;
  return <div className="row faint">turn ended{typeof cost === 'number' ? ` · $${cost.toFixed(4)}` : ''}</div>;
};
