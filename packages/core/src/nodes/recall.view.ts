import type { KindView } from './fields.js';

export default {
  kind: 'recall', order: 80, colour: 'mem', icon: 'round',
  fields: [{ key: 'knowl', label: 'Knowl', input: 'text' }], line: ['recall from Knowl', { field: 'knowl' }], card: { label: 'recall', section: 'Memory' }, fresh: () => ({}),
} satisfies KindView;
