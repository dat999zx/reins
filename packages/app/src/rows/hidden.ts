import type { LogRow } from '@reins/server/store.js';

export const hidden = new Set(['status', 'settings', 'session_created', 'answer', 'question_closed', 'command_result', 'model_switched', 'budget_reached']);
// the engine event types that draw nothing (the call row shows the result, the cost is in the turn, the context size is in the header)
export const SILENT = new Set(['tool_result', 'hook', 'cost', 'usage']);
// one predicate for "does this row draw": the feed groups with it and renderRow checks it
export const drawable = (row: LogRow): boolean => !hidden.has(row.type) && !(row.type === 'engine' && SILENT.has((row.data as { type: string } | null)?.type ?? ''));
