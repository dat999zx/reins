import type { KindView } from './fields.js';

export default {
  kind: 'run', order: 30, colour: 'hard',
  fields: [{ key: 'cmd', label: 'Command', input: 'mono' }], line: ['run', { field: 'cmd' }], fails: true, card: { label: 'run command', section: 'Flow' }, fresh: () => ({ attrs: { cmd: 'npm test' } }),
} satisfies KindView;
