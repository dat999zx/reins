import type { KindView } from './fields.js';

export default {
  kind: 'end', order: 120, colour: 'hand',
  stops: true, fields: [], line: ['end'], card: { label: 'end', section: 'Flow' }, fresh: () => ({}),
} satisfies KindView;
