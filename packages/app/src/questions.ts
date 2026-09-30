export interface Field { placeholder: string; initial?: string }
export interface Action { label: string; primary?: boolean; field?: Field; build: (input: string) => string | null }
export interface QuestionDef { kind: string; actions: Action[]; detail?: 'json' }

const defs = new Map(Object.values(import.meta.glob<QuestionDef>('./questions/*.ts', { eager: true })).map((m) => [m.kind, m]));

export const GENERIC: QuestionDef = {
  kind: '*',
  actions: [{ label: 'Send', primary: true, field: { placeholder: 'answer' }, build: (t) => (t.trim() ? t : null) }],
};

export const actionsFor = (kind: string) => (defs.get(kind) ?? GENERIC).actions;
export const detailFor = (kind: string) => defs.get(kind)?.detail;
