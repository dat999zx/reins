import type { QuestionCard } from './types.js';

export default {
  kind: 'usd',
  actions: [
    { label: 'Allow', primary: true, answer: 'allow ${text}', field: { placeholder: 'more USD', initial: '0.50', check: 'usd' } },
    { label: 'Stop', answer: 'stop' },
  ],
} satisfies QuestionCard;
