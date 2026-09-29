export type StepKind = 'phase' | 'say' | 'run' | 'gate' | 'repeat' | 'if' | 'verify' | 'use' | 'recall' | 'store' | 'handoff';
// now and stop are delivery kinds, only valid in a `whenever` block (plan 6.5).
export type CardKind = 'guard' | 'note' | 'nudge' | 'role' | 'checkpoint' | 'budget' | 'undo' | 'now' | 'stop';
export type LinkKind = 'next' | 'on-pass' | 'on-fail' | 'retry' | 'verify-against' | 'hand-off';

export interface Pos {
  line: number;
  col: number;
}

export interface Card {
  kind: CardKind;
  text: string;
  pos?: Pos;
}

export interface Link {
  kind: LinkKind;
  to: string;
  max?: number;
  pos?: Pos;
}

export interface Step {
  id: string;
  kind: StepKind;
  title?: string;
  prompt?: string; // prompt: the '>' lines, joined with \n
  attrs: Record<string, string>; // kind-specific: mode, cmd, against, to, focus, knowl, max
  cond?: Cond;
  cards: Card[];
  links: Link[];
  kids?: Step[];
  else?: Step[];
  pos?: Pos;
}

export type Cond =
  | { t: 'approve' }
  | { t: 'tests' }
  | { t: 'cmd'; cmd: string }
  | { t: 'llm'; q: string }
  | { t: 'review'; q?: string }
  | { t: 'done' }
  | { t: 'diff'; n: number }
  | { t: 'touches'; glob: string }
  | { t: 'attempts'; n: number }
  | { t: 'same' }
  | { t: 'drift' }
  | { t: 'and' | 'or'; a: Cond; b: Cond }
  | { t: 'not'; a: Cond };

export interface AutoCard {
  id: string;
  cond: Cond;
  card: Card;
}

export interface Workflow {
  version: 1;
  name: string;
  task?: string;
  engine?: 'claude' | 'codex';
  model?: string;
  test?: string;
  budget: { turns: number; minutes: number; usd?: number };
  always: string[];
  drift?: { repeat?: number; stagnation?: number };
  steps: Step[];
  autos: AutoCard[];
  block?: string;
}

export interface Diagnostic {
  severity: 'error' | 'warning';
  message: string;
  pos: Pos;
}
