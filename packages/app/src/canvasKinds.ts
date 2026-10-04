import type { CardKind, Step, StepKind } from '@reins/core';

export type FieldKey = 'title' | 'prompt' | 'mode' | 'cmd' | 'max' | 'against' | 'knowl' | 'to' | 'focus';
export type Field = { key: FieldKey; label: string; input: 'text' | 'mono' | 'textarea' | 'number' | 'mode' | 'step' };
export type Token = string | 'cond' | 'sub' | { field: FieldKey };
export type KindView = {
  group?: 'kids' | 'kids+else';
  fails?: true;
  cards?: true;
  fields: Field[];
  line: Token[];
  card?: { label: string; section: 'Flow' | 'Memory' };
  sub(step: Step, cond?: string): string;
  fresh?(): Partial<Step>;
};

const title: Field = { key: 'title', label: 'Title', input: 'text' };
const prompt: Field = { key: 'prompt', label: 'Prompt', input: 'textarea' };
const mode: Field = { key: 'mode', label: 'Mode', input: 'mode' };

export const KINDS: Record<StepKind, KindView> = {
  phase: { fields: [title, prompt, mode], line: [{ field: 'title' }, { field: 'prompt' }], cards: true, card: { label: 'phase', section: 'Flow' }, fresh: () => ({}), sub: (s) => s.title ?? '' },
  say: { fields: [prompt, mode], line: ['say', { field: 'prompt' }], cards: true, card: { label: 'custom prompt', section: 'Flow' }, fresh: () => ({}), sub: (s) => (s.prompt ?? '').split('\n')[0]!.slice(0, 40) },
  run: { fields: [{ key: 'cmd', label: 'Command', input: 'mono' }], line: ['run', { field: 'cmd' }], fails: true, card: { label: 'run command', section: 'Flow' }, fresh: () => ({ attrs: { cmd: 'npm test' } }), sub: (s) => s.attrs.cmd ?? '' },
  gate: { fields: [], line: ['wait until', 'cond'], card: { label: 'wait until', section: 'Flow' }, fresh: () => ({ cond: { t: 'approve' } }), sub: (_s, cond) => `until ${cond ?? ''}` },
  repeat: {
    group: 'kids',
    fields: [{ key: 'max', label: 'Max', input: 'number' }],
    line: ['repeat until', 'cond', 'max', { field: 'max' }],
    card: { label: 'repeat until', section: 'Flow' }, fresh: () => ({ attrs: { max: '3' }, cond: { t: 'approve' } }),
    sub: (s, cond) => `until ${cond ?? ''} · max ${s.attrs.max ?? '?'}`,
  },
  if: { group: 'kids+else', fields: [], line: ['if', 'cond'], card: { label: 'if / else', section: 'Flow' }, fresh: () => ({ cond: { t: 'approve' } }), sub: (_s, cond) => `if ${cond ?? ''}` },
  verify: {
    fields: [prompt, { key: 'against', label: 'Against', input: 'step' }],
    line: ['verify against', { field: 'against' }],
    cards: true,
    fails: true,
    card: { label: 'verify against', section: 'Flow' }, fresh: () => ({}),
    sub: (s) => `against ${s.attrs.against ?? ''}`,
  },
  recall: { fields: [{ key: 'knowl', label: 'Knowl', input: 'text' }], line: ['recall from Knowl', { field: 'knowl' }], card: { label: 'recall', section: 'Memory' }, fresh: () => ({}), sub: (s) => s.attrs.knowl ?? '' },
  store: { fields: [{ key: 'knowl', label: 'Knowl', input: 'text' }], line: ['store to Knowl', { field: 'knowl' }], card: { label: 'store', section: 'Memory' }, fresh: () => ({}), sub: (s) => s.attrs.knowl ?? '' },
  handoff: {
    fields: [{ key: 'to', label: 'To', input: 'text' }, { key: 'focus', label: 'Focus', input: 'text' }],
    line: ['hand off to', { field: 'to' }],
    card: { label: 'hand off', section: 'Flow' }, fresh: () => ({}),
    sub: (s) => s.attrs.to ?? '',
  },
  use: { fields: [], line: ['use', 'sub'], sub: (s) => s.title || s.attrs.use || s.id },
};

// whenever-only kinds (now, stop) are left out
export const CARD_KINDS: CardKind[] = ['guard', 'note', 'nudge', 'role', 'checkpoint', 'budget', 'undo'];
