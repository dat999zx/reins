import type { Diagnostic, Pos, Step, Workflow } from '../model.js';
import type { Instr } from '../compile.js';
import phase from './phase.js';
import say from './say.js';
import run from './run.js';
import gate from './gate.js';
import repeat from './repeat.js';
import ifNode from './if.js';
import verify from './verify.js';
import use from './use.js';
import recall from './recall.js';
import store from './store.js';
import handoff from './handoff.js';
import end from './end.js';

export interface HeadingCtx { line: number; col: number; push(d: Diagnostic): void }
export interface CompileCtx {
  at(): number;
  push<I extends Instr>(i: I): I;
  get(i: number): Instr | undefined;
  compile(steps: Step[]): void;
  /** After everything is compiled, set instr.onFailJump to the index of targetStepId (if it compiled to anything). */
  linkLater(instr: { onFailJump?: number }, targetStepId: string): void;
  resolveBlock?: (name: string) => Workflow | undefined;
}
export interface ValidateCtx {
  push(d: Diagnostic): void;
  pos: Pos;
  resolveBlock?: (name: string) => Workflow | undefined;
  allIds: Set<string>;
}
export interface NodeType {
  kind: string;
  attrs: string[];
  container?: 'kids' | 'kids+else';
  /** True when the step can fail, so an on-fail link on it can fire. */
  fails?: true;
  heading?: {
    parse(arg: string, step: Step, ctx: HeadingCtx): boolean;
    print(step: Step): { text: string; condInHeading: boolean };
    owns?: string[];
  };
  defaultId?(step: Step): string | undefined;
  validate?: {
    early?(step: Step, ctx: ValidateCtx): void;
    late?(step: Step, ctx: ValidateCtx): void;
    links?(step: Step, ctx: ValidateCtx): void;
  };
  compile(step: Step, ctx: CompileCtx): void;
  defaultPrompt?(step: Step): string | undefined;
  statusLine?: string;
  /** How a chat tag of this kind builds a step (3b.5). `arg` names the attribute the tag's argument fills. */
  tag?: { place: 'after' | 'wrap'; arg?: string; argRequired?: boolean; lines?: string[] };
}

export const NODES = new Map<string, NodeType>(
  [phase, say, run, gate, repeat, ifNode, verify, use, recall, store, handoff, end].map((n) => [n.kind, n]),
);

export function defaultId(step: { kind: string; title?: string }, counters: Record<string, number>): string {
  const own = NODES.get(step.kind)?.defaultId?.(step as Step);
  if (own) return own;
  counters[step.kind] = (counters[step.kind] || 0) + 1;
  return `${step.kind}-${counters[step.kind]}`;
}
export function nodeAttrs(): Set<string> { return new Set([...NODES.values()].flatMap((n) => n.attrs)); }
export function headingOwns(): Set<string> { return new Set([...NODES.values()].flatMap((n) => n.heading?.owns ?? [])); }

export { default as phaseNode } from './phase.js';
export { default as sayNode } from './say.js';
export { default as runNode } from './run.js';
export { default as gateNode } from './gate.js';
export { default as repeatNode } from './repeat.js';
export { default as ifNode } from './if.js';
export { default as verifyNode } from './verify.js';
export { default as useNode } from './use.js';
export { default as recallNode } from './recall.js';
export { default as storeNode } from './store.js';
export { default as handoffNode } from './handoff.js';
export { default as endNode } from './end.js';
