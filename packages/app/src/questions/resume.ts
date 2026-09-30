import type { Action } from '../questions.js';

export const kind = 'resume';
export const actions: Action[] = [
  { label: 'Resume', primary: true, field: { placeholder: 'note (optional)' }, build: (n) => (n.trim() ? `resume ${n.trim()}` : 'resume') },
  { label: 'Stop', build: () => 'stop' },
];
