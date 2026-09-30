import type { LogRow } from '@reins/server/store.js';
import { QuestionCard } from '../QuestionCard.js';
import type { Ctx } from '../rows.js';

export const type = 'question';
export const render = (row: LogRow, ctx: Ctx) => <QuestionCard key={row.seq} row={row} sess={ctx.sess} answer={ctx.act.answer} />;
