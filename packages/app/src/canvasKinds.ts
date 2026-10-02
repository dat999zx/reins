import type { CardKind, Step, StepKind } from '@reins/core';

export type FieldKey = 'title' | 'prompt' | 'mode' | 'cmd' | 'max' | 'against' | 'knowl' | 'to' | 'focus';
export type Field = { key: FieldKey; label: string; input: 'text' | 'mono' | 'textarea' | 'number' | 'mode' | 'step' };
export type KindView = {
  group?: 'kids' | 'kids+else';
  fails?: true;
  cards?: true;
  fields: Field[];
  sub(step: Step, cond?: string): string;
};

const title: Field = { key: 'title', label: 'Title', input: 'text' };
const prompt: Field = { key: 'prompt', label: 'Prompt', input: 'textarea' };
const mode: Field = { key: 'mode', label: 'Mode', input: 'mode' };

export const KINDS: Record<StepKind, KindView> = {
  phase: { fields: [title, prompt, mode], cards: true, sub: (s) => s.title ?? '' },
  say: { fields: [prompt, mode], cards: true, sub: (s) => (s.prompt ?? '').split('\n')[0]!.slice(0, 40) },
  run: { fields: [{ key: 'cmd', label: 'Command', input: 'mono' }], fails: true, sub: (s) => s.attrs.cmd ?? '' },
  gate: { fields: [], sub: (_s, cond) => `until ${cond ?? ''}` },
  repeat: {
    group: 'kids',
    fields: [{ key: 'max', label: 'Max', input: 'number' }],
    sub: (s, cond) => `until ${cond ?? ''} · max ${s.attrs.max ?? '?'}`,
  },
  if: { group: 'kids+else', fields: [], sub: (_s, cond) => `if ${cond ?? ''}` },
  verify: {
    fields: [prompt, { key: 'against', label: 'Against', input: 'step' }],
    cards: true,
    fails: true,
    sub: (s) => `against ${s.attrs.against ?? ''}`,
  },
  recall: { fields: [{ key: 'knowl', label: 'Knowl', input: 'text' }], sub: (s) => s.attrs.knowl ?? '' },
  store: { fields: [{ key: 'knowl', label: 'Knowl', input: 'text' }], sub: (s) => s.attrs.knowl ?? '' },
  handoff: {
    fields: [{ key: 'to', label: 'To', input: 'text' }, { key: 'focus', label: 'Focus', input: 'text' }],
    sub: (s) => s.attrs.to ?? '',
  },
  use: { fields: [], sub: (s) => s.title || s.attrs.use || s.id },
};

// whenever-only kinds (now, stop) are left out
export const CARD_KINDS: CardKind[] = ['guard', 'note', 'nudge', 'role', 'checkpoint', 'budget', 'undo'];
