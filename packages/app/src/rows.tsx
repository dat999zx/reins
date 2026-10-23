import type { ReactNode } from 'react';
import type { LogRow } from '@reins/server/store.js';
import { BlockRow } from './BlockRow.js';
import { mayRow } from '../../core/src/viewShape.js';
import { KINDS } from './canvasKinds.js';
import { generic } from './generic.js';
import type { CardState } from './feed.js';
import { drawable, hidden } from './rows/hidden.js';
import type { Sess } from './state.js';
import { fill } from './template.js';

export interface Actions { answer(questionId: string, answer: string): Promise<void>; resume(runId: string): void }
export interface Ctx {
  sess: Sess; act: Actions; card?: Map<number, CardState>;
  thinking?: { heads: Set<number>; now?: number }; running?: boolean; seenSeq?: number;
}
export interface RowDef { type: string; render(row: LogRow, ctx: Ctx): ReactNode }

const defs = new Map(Object.values(import.meta.glob<RowDef>('./rows/*.tsx', { eager: true })).map((m) => [m.type, m]));

type ViewRow = { text: string; details?: string; className?: string };

// Read live, so a view registered or disposed later is seen; a row file of the same type wins. A view never speaks for an event core logs, and the first
// view (by order) to name an event keeps it. The one exception is a pack block that lists the event in its own `coreRows` (`mayRow`): the subagent block draws its own start and result.
const viewRows = (): Record<string, ViewRow> => {
  const out: Record<string, ViewRow> = Object.create(null);
  for (const v of Object.values(KINDS)) for (const [type, r] of Object.entries(v.rows ?? {})) if (mayRow(type, v)) out[type] ??= r;
  return out;
};
// A view's row is templates over the event data; a details template that fills empty draws a plain row.
const fillRow = (v: ViewRow, data: unknown): Parameters<typeof BlockRow>[0] => {
  const details = v.details === undefined ? '' : fill(v.details, data, { lines: true });
  return { text: fill(v.text, data), ...(details === '' ? {} : { details }), ...(v.className === undefined ? {} : { className: v.className }) };
};

export { drawable, hidden };
export const rowTypes = () => [...new Set([...defs.keys(), ...Object.keys(viewRows())])];
export const renderRow = (row: LogRow, ctx: Ctx): ReactNode => {
  if (!drawable(row)) return null;
  const def = defs.get(row.type);
  if (def) return def.render(row, ctx);
  const view = viewRows()[row.type];
  return view ? <BlockRow {...fillRow(view, row.data)} /> : generic(row.type, row.data);
};
