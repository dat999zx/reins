import type { LogRow } from '@reins/server/store.js';

export const type = 'subagent_started';
export const render = (row: LogRow) => {
  const d = (row.data ?? {}) as { title?: string; label?: string; model?: string; resumed?: boolean };
  return <div className="row sx-sub">Subagent {d.title} {d.resumed ? 'resumed' : 'started'} on {d.label ?? d.model ?? 'the default model'}.</div>;
};
