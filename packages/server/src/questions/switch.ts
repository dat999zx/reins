import type { QuestionCard } from './types.js';

export default {
  kind: 'switch',
  actions: [
    { label: 'Switch', primary: true, answer: 'switch' },
    { label: 'Keep the current model', answer: 'keep' },
  ],
} satisfies QuestionCard;
