import type { KindView } from './fields.js';

export default {
  kind: 'gate', order: 40, colour: 'gate',
  fields: [], line: ['wait until', 'cond'], card: { label: 'wait until', section: 'Flow' }, fresh: () => ({ cond: { t: 'approve' } }),
} satisfies KindView;
