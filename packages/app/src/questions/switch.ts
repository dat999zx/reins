import type { Action } from '../questions.js';

export const kind = 'switch';
export const actions: Action[] = [
  { label: 'Switch', primary: true, build: () => 'switch' },
  { label: 'Keep the current model', build: () => 'keep' },
];
