import type { QuestionCard } from './types.js';

export default {
  kind: 'judge',
  actions: [
    { label: 'Yes', primary: true, answer: 'y' },
    { label: 'No', answer: 'n' },
  ],
} satisfies QuestionCard;
