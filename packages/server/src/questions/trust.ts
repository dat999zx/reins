import type { QuestionCard } from './types.js';

export default {
  kind: 'trust',
  actions: [
    { label: 'Trust', primary: true, answer: 'y' },
    { label: "Don't trust", answer: 'n' },
  ],
} satisfies QuestionCard;
