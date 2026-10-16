import { max, type KindView } from './fields.js';

export default {
  kind: 'repeat', order: 50, colour: 'loop',
  group: 'kids',
  fields: [max],
  line: ['repeat until', 'cond', 'max', { field: 'max' }],
  card: { label: 'repeat until', section: 'Flow' }, fresh: () => ({ attrs: { max: '3' }, cond: { t: 'approve' } }),
} satisfies KindView;
