import type { Cond, Diagnostic, Pos, Step, Workflow } from '../model.js';
import type { Instr } from '../compile.js';
import type { EngineSession, TurnResult } from '../fake-engine.js';
import type { CommandOutcome, PauseReason, RunEventRecord, RunEventType } from '../run.js';
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
import model from './model.js';
import subagent from './subagent.js';
import end from './end.js';

/** What the host did with a model step. `label` names the model in use afterwards. One member per `to`, so `r.label` narrows. */
export type SwitchOutcome = { to: 'switched' | 'same' | 'kept'; label: string } | { to: 'stop' } | { to: 'closed' };
export interface ExecCtx {
  /** The host puts the session on `model` before the next turn; absent in a host that cannot (the terminal). */
  switchModel?(model: string, step: string): Promise<SwitchOutcome>;
  /** The host puts the session on reasoning level `level` before the next turn; absent in a host that cannot (the terminal). */
  setReasoning?(level: string, step: string): void;
  /** Opens `step`'s USD slice from here on; undefined closes the one that is open. */
  slice(step: string, usd: number | undefined): void;
  log(type: RunEventRecord['type'], data: unknown): void;
  /** Pauses the run at this step (a `stop` pause with this step's id): Resume runs the step again. */
  pause(text: string): void;
  stop(): Promise<void>;
  /** Runs a subagent step (D): its own engine session, model and USD slice. True once its result waits for the next turn; false when the run paused or stopped. */
  subagent(step: Step, usd: number | undefined): Promise<boolean>;
}

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
  /** True when this kind's exec runs a turn compiled from the step's own prompt, so a preview can show it. */
  sendsTurn?: true;
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
  /** The ops this kind compiles to (the instruction's `op` name is the key). Op names stay as they are, so compiled programs keep their bytes. */
  ops?: Record<string, OpType<any>>;
  /** Runs this kind's NODE instruction (P12): 'next' moves on; 'stay' leaves the counter (the run paused or stopped). */
  exec?(step: Step, ctx: ExecCtx): Promise<'next' | 'stay'>;
  /** Events of this kind that the receipt counts: the name returned is the count's key (e.g. 'hops'). */
  count?: Partial<Record<RunEventType, (data: any) => string | undefined>>;
  /** Events of this kind that `reins run` prints: the line returned replaces the default print; undefined leaves it. */
  print?: Partial<Record<RunEventType, (data: any) => string | undefined>>;
  defaultPrompt?(step: Step): string | undefined;
  statusLine?: string;
  /** How a chat tag of this kind builds a step (3b.5). `arg` names the attribute the tag's argument fills. */
  tag?: { place: 'after' | 'wrap'; arg?: string; argRequired?: boolean; lines?: string[] };
}

/** What an op sees of the run. Members are getters and closures over the run's own fields; only `at` is a copy, taken when the op starts. */
export interface VmCtx {
  /** Live: `edit()` may replace the program during an await. */
  readonly program: readonly Instr[];
  /** The counter when the op started. */
  readonly at: number;
  /** Live: moves the run's own counter on one, not `at + 1`. */
  next(): void;
  /** Live. */
  goto(i: number): void;
  /** Live: the run is still `running`; check after every await. */
  running(): boolean;
  log(type: RunEventType, data: unknown): void;
  /** Judges a condition; the eval context is built when this is called. */
  judge(c: Cond): Promise<boolean>;
  /** Sets the run `paused` with this reason; logs nothing, so the op decides what to log. */
  pause(p: PauseReason): void;
  /** Replaces the recall context the next turn carries. */
  setRecall(ctx: string[]): void;
  /** The host's functions, read live; a member is absent when the host gave none. */
  readonly services: { recall?: (topics: string[]) => Promise<string[]>; store?: (what: string, summary: string) => Promise<void> };
  /** The run's session, opened on the first call. */
  ensureSession(): Promise<EngineSession>;
  /** A turn of the parent: the handed-back results are copied for `compile` and taken off the queue only after the turn returns. Opens no session. */
  turn(session: EngineSession, stepId: string, compile: (handed: string[]) => string): Promise<TurnResult | undefined>;
  /** What each step answered, by step id: the run's own map, live; read it, do not change it. */
  readonly outputs: ReadonlyMap<string, string>;
  /** Spends one pass through the link `key` (from a step to `to`); false when its budget `max` is used up and the run paused. */
  takeLink(key: string, to: number, max: number | undefined): boolean;
  /** Runs a shell command with the host's runner and records its result for the conditions; logs nothing. */
  command(cmd: string): Promise<CommandOutcome>;
  /** The text of a turn for `step` at top-level index `top`, with the run's name, steps and `always` read live. Drains no cards and adds no recall context. */
  turnText(step: Step, handed: string[], top: number): string;
  /** The loop attempt count (bump adds one) and the extra attempts "Allow more" granted, by loop step id: live views over the run's own maps. */
  readonly loops: { bump(step: string): number; extra(step: string): number };
}

/** A kind's own instruction: `exec` runs it again from the start after a pause or crash. */
export interface OpType<I extends Instr> {
  exec(instr: I, vm: VmCtx): Promise<void>;
  /** Where the reach walk goes from here (undefined: no such place); replaces `[at + 1]`. */
  next?(instr: I, at: number): Array<number | undefined>;
  /** The commands the instruction runs on its own, for the trust hash. */
  commands?(instr: I): string[];
  /** Where "Allow more" sends the run back to for an instruction that paused for its budget (undefined: nowhere). */
  allowMore?(instr: I): number | undefined;
}

/** The instructions the run itself executes: a kind cannot bring these. */
const CORE_OPS = ['TURN', 'JUMP', 'END', 'NODE'];

export const NODES = new Map<string, NodeType>();

/** Adds a kind and the ops it brings. Throws on a known kind, a core op or a taken op, and then adds nothing. Returns a function that removes them again. */
export function register(n: NodeType): () => void {
  if (NODES.has(n.kind)) throw new Error(`kind "${n.kind}" is already registered`);
  for (const op of Object.keys(n.ops ?? {})) {
    if (CORE_OPS.includes(op)) throw new Error(`op "${op}" is a core op`);
    const owner = [...NODES.values()].find((k) => k.ops && Object.hasOwn(k.ops, op));
    if (owner) throw new Error(`op "${op}" is already brought by kind "${owner.kind}"`);
  }
  NODES.set(n.kind, n);
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    NODES.delete(n.kind);
  };
}
for (const n of [phase, say, run, gate, repeat, ifNode, verify, use, recall, store, model, subagent, end]) register(n);

export function opOf(op: string): OpType<any> | undefined {
  for (const n of NODES.values()) if (n.ops && Object.hasOwn(n.ops, op)) return n.ops[op];
  return undefined;
}

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
export { default as modelNode } from './model.js';
export { default as subagentNode } from './subagent.js';
export { default as endNode } from './end.js';
