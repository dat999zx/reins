// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface NodeKinds {}
export type StepKind = keyof NodeKinds;
// now and stop are delivery kinds, only valid in a `whenever` block (plan 6.5).
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CardKinds {}
export type CardKind = keyof CardKinds;
export type LinkKind = 'next' | 'on-fail';

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
  attrs: Record<string, string>; // kind-specific: mode, cmd, against, knowl, max
  cond?: Cond;
  cards: Card[];
  links: Link[];
  kids?: Step[];
  else?: Step[];
  pos?: Pos;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CondAtoms {}
export type Cond = CondAtoms[keyof CondAtoms] | { t: 'and' | 'or'; a: Cond; b: Cond } | { t: 'not'; a: Cond };

export interface AutoCard {
  id: string;
  cond: Cond;
  card: Card;
}

export interface Workflow {
  version: 1;
  name: string;
  task?: string;
  test?: string;
  budget: { turns: number; minutes: number; usd?: number };
  always: string[];
  drift?: { repeat?: number; stagnation?: number };
  steps: Step[];
  autos: AutoCard[];
  block?: string;
  /** Set only by a host that reads a block file for a playbook: what the parser said about the file (errors and warnings), so the playbook can show them. */
  problems?: Diagnostic[];
}

export interface Diagnostic {
  severity: 'error' | 'warning';
  message: string;
  pos: Pos;
}
