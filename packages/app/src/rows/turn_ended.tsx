import type { LogRow } from '@reins/server/store.js';
import { dollars, UNKNOWN_COST } from '../unknown.js';

export const type = 'turn_ended';
export const render = (row: LogRow) => {
  const d = row.data as { cost?: number; unknown?: boolean } | null;
  const cost = d?.cost;
  return <div className="row faint">turn ended{typeof cost === 'number' ? ` · ${dollars(cost, 4, d?.unknown)}` : ''}{typeof cost !== 'number' && d?.unknown ? ` · ${UNKNOWN_COST}` : ''}</div>;
};
