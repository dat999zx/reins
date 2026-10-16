import type { CardKind, StepKind } from '@reins/core';

import { max, mode, mustPrompt, prompt, reasoning, title, usd, type KindView } from '../../core/src/nodes/fields.js';
import type { WireKind } from './canvas.js';

export type { Field, KindView, Token } from '../../core/src/nodes/fields.js';

export const KINDS: Record<StepKind, KindView> = {
  phase: { fields: [title, mustPrompt, mode], line: [{ field: 'title' }, { field: 'prompt' }], cards: true, card: { label: 'phase', section: 'Flow' }, fresh: () => ({}) },
  say: { fields: [prompt, mode], line: ['say', { field: 'prompt' }], cards: true, card: { label: 'custom prompt', section: 'Flow' }, fresh: () => ({}) },
  run: { fields: [{ key: 'cmd', label: 'Command', input: 'mono' }], line: ['run', { field: 'cmd' }], fails: true, card: { label: 'run command', section: 'Flow' }, fresh: () => ({ attrs: { cmd: 'npm test' } }) },
  gate: { fields: [], line: ['wait until', 'cond'], card: { label: 'wait until', section: 'Flow' }, fresh: () => ({ cond: { t: 'approve' } }) },
  repeat: {
    group: 'kids',
    fields: [max],
    line: ['repeat until', 'cond', 'max', { field: 'max' }],
    card: { label: 'repeat until', section: 'Flow' }, fresh: () => ({ attrs: { max: '3' }, cond: { t: 'approve' } }),
  },
  if: { group: 'kids+else', fields: [], line: ['if', 'cond'], card: { label: 'if / else', section: 'Flow' }, fresh: () => ({ cond: { t: 'approve' } }) },
  verify: {
    fields: [prompt, { key: 'against', label: 'Against', input: 'step' }],
    line: ['verify against', { field: 'against' }],
    cards: true,
    fails: true,
    against: true,
    card: { label: 'verify against', section: 'Flow' }, fresh: () => ({}),
  },
  recall: { fields: [{ key: 'knowl', label: 'Knowl', input: 'text' }], line: ['recall from Knowl', { field: 'knowl' }], card: { label: 'recall', section: 'Memory' }, fresh: () => ({}) },
  store: { fields: [{ key: 'knowl', label: 'Knowl', input: 'text' }], line: ['store to Knowl', { field: 'knowl' }], card: { label: 'store', section: 'Memory' }, fresh: () => ({}) },
  model: {
    fields: [{ key: 'model', label: 'Model', input: 'model' }, reasoning, usd],
    line: ['switch model to', { field: 'model' }, { field: 'reasoning' }, 'USD', { field: 'usd' }],
    card: { label: 'switch model', section: 'Flow' }, fresh: () => ({}),
  },
  subagent: {
    fields: [title, mustPrompt, mode, { key: 'model', label: 'Model', input: 'model', inherits: true }, reasoning, usd],
    line: ['subagent', { field: 'title' }, 'on', { field: 'model' }, { field: 'reasoning' }, { field: 'mode' }, 'USD', { field: 'usd' }, { field: 'prompt' }],
    cards: true,
    card: { label: 'subagent', section: 'Flow' }, fresh: () => ({}),
  },
  end: { stops: true, fields: [], line: ['end'], card: { label: 'end', section: 'Flow' }, fresh: () => ({}) },
  use: { fields: [], line: ['use', 'sub'], sub: (s) => s.title || s.attrs.use || s.id },
};

// Adds a view for tests and later kinds; the disposer takes it out again.
export function registerView(v: KindView & { kind: string }): () => void {
  if (v.kind in KINDS) throw new Error(`a view for ${v.kind} is already registered`);
  const kinds: Record<string, KindView> = KINDS;
  kinds[v.kind] = v;
  return () => { delete kinds[v.kind]; };
}

// The handles on a block, top to bottom.
export const wiresOf = (kind: StepKind): WireKind[] => {
  const k = KINDS[kind];
  return k.stops ? [] : ['next', ...(k.fails ? ['on-fail' as const] : []), ...(k.against ? ['against' as const] : [])];
};

// The card kinds a block holds; whenever-only kinds (now, stop) are left out.
// guard is enforced in core/src/policy.ts: the tool-approval hook blocks edits to a matching path and shell commands naming one.
export const CARD_KINDS = ['guard'] as const satisfies readonly CardKind[];
// The words the panel uses for a kind: a second kind is one entry here.
export const CARD_LABEL: Record<(typeof CARD_KINDS)[number], { section: string; add: string }> = {
  guard: { section: 'Guards', add: 'Add guard' },
};
