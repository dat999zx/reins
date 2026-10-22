import type { ReactNode } from 'react';
import type { LogRow } from '@reins/server/store.js';
import { BlockRow } from './BlockRow.js';
import { KINDS, type KindView } from './canvasKinds.js';
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

// Read live, so a view registered or disposed later is seen; a row file of the same type wins.
const viewRows = () => Object.assign({}, ...Object.values(KINDS).map((v) => v.rows)) as NonNullable<KindView['rows']>;

type ViewRow = { text: string; details?: string; className?: string };
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
  const rows = viewRows() as Record<string, ViewRow>;
  const view = Object.hasOwn(rows, row.type) ? rows[row.type] : undefined;
  return view ? <BlockRow {...fillRow(view, row.data)} /> : generic(row.type, row.data);
};
