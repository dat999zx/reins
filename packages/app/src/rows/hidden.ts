import type { LogRow } from '@reins/server/store.js';
import { viewHidden, viewHides } from '../viewEvents.js';

// The row types of the app and of core's own events that draw nothing. The events of a kind come from its served view (`view.hidden`).
const BASE = ['status', 'settings', 'session_created', 'answer', 'question_closed', 'command_result', 'budget_reached'];
/** Read live: `has` and iteration see the base list and every served view's `hidden`. */
export const hidden: { has(type: string): boolean; [Symbol.iterator](): Iterator<string> } = {
  has: (type) => BASE.includes(type) || viewHides(type),
  [Symbol.iterator]: () => new Set([...BASE, ...viewHidden()])[Symbol.iterator](),
};
// the engine event types that draw nothing (the call row shows the result, the cost is in the turn, the context size is in the header)
export const SILENT = new Set(['tool_result', 'hook', 'cost', 'usage']);
// one predicate for "does this row draw": the feed groups with it and renderRow checks it
export const drawable = (row: LogRow): boolean => !hidden.has(row.type) && !(row.type === 'engine' && SILENT.has((row.data as { type: string } | null)?.type ?? ''));
