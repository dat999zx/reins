import type { Step } from '../model.js';

// The front side of a kind: types and the few field objects several kinds share. Browser-safe: `import type` lines only.
// `error` is what the panel says when applyField refuses the value; `inherits`: an empty model is the session's model; `ph` overrides the
// empty pill's placeholder; `required`: the validator warns while it is empty, so the face says so.
// `check`: count = a whole number, 1 or more; usd = an amount above 0 (empty means none). `unset`: the value that means absent.
export type Field = {
  key: string; label: string; input: 'text' | 'mono' | 'textarea' | 'number' | 'mode' | 'step' | 'model' | 'effort';
  error?: string; inherits?: true; ph?: string; required?: true;
  check?: 'count' | 'usd'; unset?: string;
};
export type Token = string | 'cond' | 'sub' | { field: string };
export type KindView = {
  kind?: string; order?: number; colour?: 'soft' | 'hard' | 'gate' | 'loop' | 'verify' | 'hand' | 'mem' | 'mine'; // required in Task 9
  group?: 'kids' | 'kids+else';
  fails?: true;
  stops?: true; // ends the workflow: no links out, drawn as a cap
  against?: true; // has a third wire: the step whose work it compares
  cards?: true;
  fields: Field[];
  line: Token[];
  card?: { label: string; section: 'Flow' | 'Memory' };
  sub?(step: Step, cond?: string): string;
  fresh?(): Partial<Step>;
};

export const USD_ERROR = 'USD must be an amount above 0, like 2.50. Leave it empty for no USD limit.';

export const title: Field = { key: 'title', label: 'Title', input: 'text' };
export const prompt: Field = { key: 'prompt', label: 'Prompt', input: 'textarea' };
export const mode: Field = { key: 'mode', label: 'Mode', input: 'mode', unset: 'write' };
export const mustPrompt: Field = { ...prompt, required: true }; // phase and subagent: core warns "has no prompt"
export const reasoning: Field = { key: 'reasoning', label: 'Reasoning', input: 'effort', inherits: true };
export const usd: Field = { key: 'usd', label: 'Budget (USD)', input: 'text', error: USD_ERROR, ph: 'optional', check: 'usd' };
export const max: Field = { key: 'max', label: 'Max', input: 'number', check: 'count' };
