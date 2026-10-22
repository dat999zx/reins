import type { KindView } from './fields.js';

export default {
  kind: 'use', order: 130, colour: 'mine',
  fields: [], line: ['use', 'sub'], sub: '{title|attrs.use|id}',
} satisfies KindView;
