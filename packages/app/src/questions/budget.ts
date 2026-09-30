import type { Action } from '../questions.js';

export const kind = 'budget';
export const actions: Action[] = [
  { label: 'Allow', primary: true, field: { placeholder: 'more turns', initial: '2' }, build: (n) => (/^\d+$/.test(n.trim()) && Number(n) >= 1 ? `allow ${Number(n)}` : null) },
  { label: 'Stop', build: () => 'stop' },
];
