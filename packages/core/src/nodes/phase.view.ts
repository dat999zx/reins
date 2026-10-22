import { mode, mustPrompt, title, type KindView } from './fields.js';

export default {
  kind: 'phase', order: 10, colour: 'soft',
  fields: [title, mustPrompt, mode], line: [{ field: 'title' }, { field: 'prompt' }], cards: true, card: { label: 'phase', section: 'Flow' }, fresh: {},
} satisfies KindView;
