import type { QuestionCard } from './types.js';

export default {
  kind: 'resume',
  actions: [
    { label: 'Resume', primary: true, answer: 'resume {text}', field: { placeholder: 'note (optional)', empty: 'resume' } },
    { label: 'Stop', answer: 'stop' },
  ],
} satisfies QuestionCard;
