import type { Action } from '../questions.js';
import { parseBudget } from '../panelEdit.js';

export const kind = 'usd';
export const actions: Action[] = [
  {
    label: 'Allow', primary: true, field: { placeholder: 'more USD', initial: '0.50' },
    build: (v) => { const r = parseBudget('usd', v); return 'value' in r && r.value !== undefined ? `allow $${v.trim()}` : null; },
  },
  { label: 'Stop', build: () => 'stop' },
];
