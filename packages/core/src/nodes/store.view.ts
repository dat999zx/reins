import type { KindView } from './fields.js';

export default {
  kind: 'store', order: 90, colour: 'mem', icon: 'round',
  fields: [{ key: 'knowl', label: 'Knowl', input: 'text' }], line: ['store to Knowl', { field: 'knowl' }], card: { label: 'store', section: 'Memory' }, fresh: () => ({}),
} satisfies KindView;
