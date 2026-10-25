import type { QuestionCard } from './types.js';

export default {
  kind: 'tool',
  detail: 'json',
  actions: [
    { label: 'Allow', primary: true, answer: 'y' },
    { label: 'Deny', answer: 'n {text}', field: { placeholder: 'reason (optional)', empty: 'n' } },
  ],
} satisfies QuestionCard;
