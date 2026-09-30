import type { Action } from '../questions.js';

export const kind = 'tool';
export const detail = 'json';
export const actions: Action[] = [
  { label: 'Allow', primary: true, build: () => 'y' },
  { label: 'Deny', field: { placeholder: 'reason (optional)' }, build: (r) => (r.trim() ? `n ${r.trim()}` : 'n') },
];
