import type { QuestionAction, QuestionCard } from '@reins/server/questions/types.js';
import { parseBudget } from './panelEdit.js';

export interface Field { placeholder: string; initial?: string }
export interface Action { label: string; primary?: boolean; field?: Field; build: (input: string) => string | null }
export interface QuestionDef { kind: string; actions: Action[]; detail?: 'json' }

// The question cards come from the server (`GET /api/kinds`, read in App.tsx), as data; the app holds none of its own. Until the reply (or for a
// kind it does not list) the generic card is shown. Keyed by own name only: a question of kind `constructor` finds nothing.
const defs = new Map<string, QuestionDef>();

// The checks a field names. Each returns the text to send, or null when the text is not allowed.
const CHECKS: Record<NonNullable<NonNullable<QuestionAction['field']>['check']>, (t: string) => string | null> = {
  usd: (t) => { const r = parseBudget('usd', t); return 'value' in r && r.value !== undefined ? t : null; },
  count: (t) => (/^\d+$/.test(t) && Number(t) >= 1 ? String(Number(t)) : null),
};

// The button's answer for the typed text: the template with `{text}` filled, the field's `empty` answer for no text, or null (the button is off).
function build(a: QuestionAction): (input: string) => string | null {
  const f = a.field;
  if (!f) return () => a.answer;
  return (input) => {
    const t = input.trim();
    const v = f.check ? CHECKS[f.check](t) : t;
    if (v === null) return null;
    if (v === '') return f.empty ?? null;
    return a.answer.replace('{text}', () => v);
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const okAction = (a: unknown): a is QuestionAction => {
  if (!isObj(a) || typeof a.label !== 'string' || typeof a.answer !== 'string') return false;
  if (a.field === undefined) return true;
  const f = a.field;
  return isObj(f) && typeof f.placeholder === 'string' && (f.initial === undefined || typeof f.initial === 'string') && (f.empty === undefined || typeof f.empty === 'string')
    && (f.check === undefined || (typeof f.check === 'string' && Object.hasOwn(CHECKS, f.check)));
};
const okCard = (c: unknown): c is QuestionCard => isObj(c) && typeof c.kind === 'string' && Array.isArray(c.actions) && c.actions.length > 0 && c.actions.every(okAction);

/** Fills the cards from the server's list. An entry that does not read (an unknown check, a missing word) is left out, so its kind gets the generic card. */
export function setQuestions(list: unknown): void {
  defs.clear();
  if (!Array.isArray(list)) return;
  for (const c of list) {
    if (!okCard(c)) continue;
    defs.set(c.kind, {
      kind: c.kind,
      ...(c.detail === 'json' ? { detail: 'json' as const } : {}),
      actions: c.actions.map((a) => ({ label: a.label, ...(a.primary ? { primary: true } : {}), ...(a.field ? { field: { placeholder: a.field.placeholder, ...(a.field.initial === undefined ? {} : { initial: a.field.initial }) } } : {}), build: build(a) })),
    });
  }
}

export const GENERIC: QuestionDef = {
  kind: '*',
  actions: [{ label: 'Send', primary: true, field: { placeholder: 'answer' }, build: (t) => (t.trim() ? t : null) }],
};

export const actionsFor = (kind: string) => (defs.get(kind) ?? GENERIC).actions;
export const detailFor = (kind: string) => defs.get(kind)?.detail;
export const offersStop = (kind: string) => actionsFor(kind).some((a) => a.build('') === 'stop');
