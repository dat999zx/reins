import { mode, prompt, type KindView } from './fields.js';

export default {
  kind: 'say', order: 20, colour: 'soft',
  fields: [prompt, mode], line: ['say', { field: 'prompt' }], cards: true, card: { label: 'custom prompt', section: 'Flow' }, fresh: () => ({}),
} satisfies KindView;
