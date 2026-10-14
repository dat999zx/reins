import type { LogRow } from '@reins/server/store.js';

export const type = 'subagent_result';
export const render = (row: LogRow) => {
  const d = (row.data ?? {}) as { title?: string; text?: string; cost?: number };
  return (
    <details className="row sx-sub">
      <summary>Subagent {d.title} handed back its result{typeof d.cost === 'number' ? ` ($${d.cost.toFixed(4)})` : ''}.</summary>
      <pre>{d.text}</pre>
    </details>
  );
};
