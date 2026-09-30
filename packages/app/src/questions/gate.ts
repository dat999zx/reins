import type { Action } from '../questions.js';

export const kind = 'gate';
export const actions: Action[] = [
  { label: 'Approve', primary: true, build: () => 'approve' },
  { label: 'Request changes', field: { placeholder: 'what to change' }, build: (n) => (n.trim() ? `changes ${n.trim()}` : null) },
  { label: 'Stop', build: () => 'stop' },
];
