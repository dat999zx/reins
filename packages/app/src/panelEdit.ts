import type { Link, Step } from '@reins/core';
import type { FieldKey } from './canvasKinds.js';

export const fieldValue = (s: Step, key: FieldKey): string =>
  (key === 'title' ? s.title : key === 'prompt' ? s.prompt : s.attrs[key]) ?? '';

const validMax = (v: string) => /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) && Number(v) >= 1;

// Mutates the step (call it inside editStep, which clones). Empty text removes the field.
// Returns false when the value is refused (nothing changed).
export function applyField(s: Step, key: FieldKey, v: string): boolean {
  if (key === 'max' && !validMax(v)) return false;
  if (key === 'usd') {
    const r = parseBudget('usd', v);
    if ('error' in r) return false;
    if (r.value === undefined) delete s.attrs.usd;
    else s.attrs.usd = v.trim();
    return true;
  }
  if (key === 'title' || key === 'prompt') {
    if (v === '') delete s[key];
    else s[key] = v;
  } else if (v === '') delete s.attrs[key];
  else s.attrs[key] = v;
  return true;
}

export function applyLinkMax(l: Link, v: string): void {
  if (validMax(v)) l.max = Number(v);
  else delete l.max;
}

export type BudgetKey = 'turns' | 'minutes' | 'usd';

export const BUDGET_ERRORS: Record<BudgetKey, string> = {
  turns: 'Turns must be a whole number, 1 or more.',
  minutes: 'Minutes must be a whole number, 1 or more.',
  usd: 'USD must be an amount above 0, like 2.50. Leave it empty for no USD limit.',
};
export const BUDGET_BOTH = 'Fill in both Turns and Minutes.';
export const BUDGET_HINT = 'Turns stop the run when used up. USD pauses it before the next step once a reply reaches it: allow more or stop. Minutes are shown, not enforced.';

// What one budget field's commit writes. While either of Turns and Minutes is 0 ("not set") the pair is written together,
// or the file would print `minutes: 0` and the run meter would read "over" at once.
export function budgetPatch(
  key: BudgetKey, raw: string, now: { turns: number; minutes: number }, drafts: { turns: string; minutes: string },
): { patch: Partial<Record<BudgetKey, number | undefined>> } | { error: string } {
  const r = parseBudget(key, raw);
  if ('error' in r) return r;
  const other = key === 'turns' ? 'minutes' : key === 'minutes' ? 'turns' : undefined;
  if (other && (now.turns === 0 || now.minutes === 0)) {
    const o = parseBudget(other, drafts[other]);
    if ('error' in o) return { error: BUDGET_BOTH };
    return { patch: { [key]: r.value, [other]: o.value } };
  }
  return { patch: { [key]: r.value } };
}

// A count as the form shows it: 0 is "not set" (a file without a budget parses to 0).
export const budgetCount = (n: number) => (n === 0 ? '' : String(n));

// The one place a budget field's text is judged. An empty USD is "no USD limit"; turns and minutes need a value.
export function parseBudget(key: BudgetKey, raw: string): { value: number | undefined } | { error: string } {
  const v = raw.trim();
  if (key === 'usd') {
    if (v === '') return { value: undefined };
    return /^\d+(\.\d{1,2})?$/.test(v) && Number(v) > 0 ? { value: Number(v) } : { error: BUDGET_ERRORS.usd };
  }
  return validMax(v) ? { value: Number(v) } : { error: BUDGET_ERRORS[key] };
}