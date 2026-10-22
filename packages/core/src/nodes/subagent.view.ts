import { mode, mustPrompt, reasoning, title, usd, type KindView } from './fields.js';

export default {
  kind: 'subagent', order: 110, colour: 'mine', slice: 'own',
  fields: [title, mustPrompt, mode, { key: 'model', label: 'Model', input: 'model', inherits: true }, reasoning, usd],
  line: ['subagent', { field: 'title' }, 'on', { field: 'model' }, { field: 'reasoning' }, { field: 'mode' }, 'USD', { field: 'usd' }, { field: 'prompt' }],
  cards: true,
  card: { label: 'subagent', section: 'Flow' }, fresh: {},
} satisfies KindView;
