import type { Action } from '../questions.js';

export const kind = 'trust';
export const actions: Action[] = [
  { label: 'Trust', primary: true, build: () => 'y' },
  { label: "Don't trust", build: () => 'n' },
];
