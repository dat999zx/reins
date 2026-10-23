import type { Step } from '../model.js';
import type { RunEventType } from '../run.js';

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
/** The states a step can be in on the run's marks (the app's `StepState`). */
export type StatusState = 'active' | 'done' | 'waiting' | 'stuck' | 'failed';
/** Applies only when the event's data holds `key` itself and its value is one of `is`. */
export type StatusWhen = { key: string; is: Array<string | number | boolean> };
/**
 * What one of this kind's events does to the marks of the run, as data (the app's stepStatus and feed read it; no code). Without `step` the rule
 * is about the step the event names in its `step`; `step: 'track'` is the step the event's track is on. `state` sets the step's state; `why` its
 * words (text, or a word picked by the data's `key` from `words`, then a space and the data's `add`; no such word, no `add`: the words are cleared);
 * `attempts` copies the number in that data key; `cursor` makes it the track's current step; `gate` its open gate; `opens` opens its knot in a log
 * that has no `step_started` rows; `label` remembers the label the data's `name` gives the model in `model`.
 */
export type StatusRule = {
  when?: StatusWhen; step?: 'track'; state?: StatusState;
  why?: string | { key: string; words: Record<string, string>; add?: string };
  attempts?: string; cursor?: true; gate?: true; opens?: true;
  label?: { model: string; name: string; when?: StatusWhen };
};
export type KindView = {
  kind: string; order: number; colour: 'soft' | 'hard' | 'gate' | 'loop' | 'verify' | 'hand' | 'mem' | 'mine';
  icon?: 'round'; // the palette card's mark is a circle
  slice?: 'opens' | 'own'; // the run's usage slice: opens = a switch that starts a new one, own = the block is its own slice
  group?: 'kids' | 'kids+else';
  fails?: true;
  manyNext?: true; // the face has the gray `next` handle, and each drag adds a wire
  stops?: true; // ends the workflow: no links out, drawn as a cap
  against?: true; // has a third wire: the step whose work it compares
  cards?: true;
  fields: Field[];
  line: Token[];
  card?: { label: string; section: 'Flow' | 'Memory' };
  // A view is plain JSON. `sub` is a template over the step (what the `sub` token shows), `fresh` the fields of a new block,
  // `rows` templates over the event data; the filler is app/src/template.ts: `{path}`, `{a|b}` (first with text), `{path:usd}`, `{path:count}`.
  sub?: string;
  fresh?: Partial<Step>;
  // feed rows this kind brings, by event type; a row file of the same type wins. `details` filled empty means a plain row.
  rows?: Partial<Record<RunEventType, { text: string; details?: string; className?: 'sx-sub' | 'faint' }>>;
  // what this kind's events do to the run's marks and the feed (see StatusRule); an event with a rule is structure, not a row, unless it is in `hidden`
  status?: Partial<Record<RunEventType, StatusRule>>;
  // events of this kind that draw no row at all
  hidden?: RunEventType[];
};

export const USD_ERROR = 'USD must be an amount above 0, like 2.50. Leave it empty for no USD limit.';

export const title: Field = { key: 'title', label: 'Title', input: 'text' };
export const prompt: Field = { key: 'prompt', label: 'Prompt', input: 'textarea' };
export const mode: Field = { key: 'mode', label: 'Mode', input: 'mode', unset: 'write' };
export const mustPrompt: Field = { ...prompt, required: true }; // phase and subagent: core warns "has no prompt"
export const reasoning: Field = { key: 'reasoning', label: 'Reasoning', input: 'effort', inherits: true };
export const usd: Field = { key: 'usd', label: 'Budget (USD)', input: 'text', error: USD_ERROR, ph: 'optional', check: 'usd' };
export const max: Field = { key: 'max', label: 'Max', input: 'number', check: 'count' };
