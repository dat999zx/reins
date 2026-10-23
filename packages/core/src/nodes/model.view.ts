import { reasoning, usd, type KindView } from './fields.js';

export default {
  kind: 'model', order: 100, colour: 'mine', slice: 'opens',
  fields: [{ key: 'model', label: 'Model', input: 'model' }, reasoning, usd],
  line: ['switch model to', { field: 'model' }, { field: 'reasoning' }, 'USD', { field: 'usd' }],
  card: { label: 'switch model', section: 'Flow' }, fresh: {},
  // done at once (step_started moves only `active` steps on, so a `waiting` model step would stay waiting); the words say what the switch did
  status: {
    model_switched: {
      state: 'done',
      why: { key: 'how', words: { switched: 'now', same: 'already on', kept: 'kept' }, add: 'label' },
      label: { model: 'model', name: 'label', when: { key: 'how', is: ['switched', 'same'] } },
    },
  },
  hidden: ['model_switched'],
} satisfies KindView;
