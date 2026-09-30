import type { ReactNode } from 'react';
import type { LogRow } from '@reins/server/store.js';
import { generic } from './generic.js';
import { hidden } from './rows/hidden.js';
import type { Sess } from './state.js';

export interface Actions { answer(questionId: string, answer: string): Promise<void>; resume(runId: string): void }
export interface Ctx { sess: Sess; act: Actions }
export interface RowDef { type: string; render(row: LogRow, ctx: Ctx): ReactNode }

const defs = new Map(Object.values(import.meta.glob<RowDef>('./rows/*.tsx', { eager: true })).map((m) => [m.type, m]));

export { hidden };
export const rowTypes = () => [...defs.keys()];
export const renderRow = (row: LogRow, ctx: Ctx): ReactNode => {
  if (hidden.has(row.type)) return null;
  const def = defs.get(row.type);
  return def ? def.render(row, ctx) : generic(row.type, row.data);
};
