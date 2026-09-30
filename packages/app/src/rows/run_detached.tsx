import type { LogRow } from '@reins/server/store.js';
import type { Ctx } from '../rows.js';

export const type = 'run_detached';
export const render = (row: LogRow, { sess, act }: Ctx) => {
  const error = (row.data as { error?: string } | null)?.error;
  const can = row.runId !== undefined && sess.detached.includes(row.runId) && (sess.status === 'idle' || sess.status === 'closed');
  return (
    <div className="row bad">
      {error ?? 'the run was left paused; Resume continues it'}{' '}
      {can && <button onClick={() => act.resume(row.runId!)}>Resume</button>}
    </div>
  );
};
