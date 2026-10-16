import { reasoning, usd, type KindView } from './fields.js';

export default {
  kind: 'model', order: 100, colour: 'mine', slice: 'opens',
  fields: [{ key: 'model', label: 'Model', input: 'model' }, reasoning, usd],
  line: ['switch model to', { field: 'model' }, { field: 'reasoning' }, 'USD', { field: 'usd' }],
  card: { label: 'switch model', section: 'Flow' }, fresh: () => ({}),
} satisfies KindView;
