import { prompt, type KindView } from './fields.js';

export default {
  kind: 'verify', order: 70, colour: 'verify',
  fields: [prompt, { key: 'against', label: 'Against', input: 'step' }],
  line: ['verify against', { field: 'against' }],
  cards: true,
  fails: true,
  against: true,
  card: { label: 'verify against', section: 'Flow' }, fresh: () => ({}),
} satisfies KindView;
