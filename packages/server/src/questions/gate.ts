import type { QuestionCard } from './types.js';

export default {
  kind: 'gate',
  actions: [
    { label: 'Approve', primary: true, answer: 'approve' },
    { label: 'Request changes', answer: 'changes {text}', field: { placeholder: 'what to change' } },
    { label: 'Stop', answer: 'stop' },
  ],
} satisfies QuestionCard;
