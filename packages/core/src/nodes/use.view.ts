import type { KindView } from './fields.js';

export default {
  kind: 'use', order: 130, colour: 'mine',
  fields: [], line: ['use', 'sub'], sub: (s) => s.title || s.attrs.use || s.id,
} satisfies KindView;
