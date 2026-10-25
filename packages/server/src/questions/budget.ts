import type { QuestionCard } from './types.js';

export default {
  kind: 'budget',
  actions: [
    { label: 'Allow', primary: true, answer: 'allow {text}', field: { placeholder: 'more turns', initial: '2', check: 'count' } },
    { label: 'Stop', answer: 'stop' },
  ],
} satisfies QuestionCard;
