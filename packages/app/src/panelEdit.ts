import type { Link, Step } from '@reins/core';
import type { FieldKey } from './canvasKinds.js';

export const fieldValue = (s: Step, key: FieldKey): string =>
  (key === 'title' ? s.title : key === 'prompt' ? s.prompt : s.attrs[key]) ?? '';

const validMax = (v: string) => /^\d+$/.test(v) && Number(v) >= 1;

// Mutates the step (call it inside editStep, which clones). Empty text removes the field.
// Returns false when the value is refused (nothing changed).
export function applyField(s: Step, key: FieldKey, v: string): boolean {
  if (key === 'max' && !validMax(v)) return false;
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
