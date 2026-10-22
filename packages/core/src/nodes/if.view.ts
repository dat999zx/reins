import type { KindView } from './fields.js';

export default {
  kind: 'if', order: 60, colour: 'loop',
  group: 'kids+else', fields: [], line: ['if', 'cond'], card: { label: 'if / else', section: 'Flow' }, fresh: { cond: { t: 'approve' } },
} satisfies KindView;
