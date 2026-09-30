import type { Action } from '../questions.js';

export const kind = 'judge';
export const actions: Action[] = [
  { label: 'Yes', primary: true, build: () => 'y' },
  { label: 'No', build: () => 'n' },
];
