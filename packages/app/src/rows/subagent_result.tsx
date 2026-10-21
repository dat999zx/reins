import type { LogRow } from '@reins/server/store.js';
import { Md } from '../Md.js';
import { dollars } from '../unknown.js';

export const type = 'subagent_result';
export const render = (row: LogRow) => {
  const d = (row.data ?? {}) as { title?: string; text?: string; cost?: number; unknown?: boolean };
  return (
    <details className="row sx-sub">
      <summary>Subagent {d.title} handed back its result{typeof d.cost === 'number' ? ` (${dollars(d.cost, 4, d.unknown)})` : ''}.</summary>
      <Md text={d.text ?? ''} />
    </details>
  );
};
