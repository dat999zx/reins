import type { Cond, Diagnostic, Pos, Step, Workflow } from '../model.js';
import type { Instr } from '../compile.js';
import type { EngineSession, TurnResult } from '../fake-engine.js';
import type { CommandOutcome, PauseReason, RunEventRecord, RunEventType } from '../run.js';
import { ordered } from '../registry.js';
import { guardNode } from '../guard.js';
import use from './use.js';

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
  /** After everything is compiled: apply(the index where targetStepId's instructions begin; for a step that compiled to nothing, the next instruction), or apply(fallback) when the id is unknown and fallback >= 0. Applied in the order called. */
  linkTo(targetStepId: string, apply: (index: number) => void, fallback?: number): void;
  /** = linkTo(targetStepId, (t) => { instr.onFailJump = t; }); kept so verify.ts and run.ts compile byte for byte. */
  linkLater(instr: { onFailJump?: number }, targetStepId: string): void;
  /**
   * For a step with a condition whose kids were just compiled (the instructions from `from` to here): each of them whose op has `inLoop` is handed the loop (`exit` is the instruction after the loop's end)
   * and takes the patch it returns. The step's own instructions only. True when one took the loop's condition, so the loop need not judge it itself.
   */
  loopBody(step: Step, from: number, exit: number): boolean;
  resolveBlock?: (name: string) => Workflow | undefined;
}
export interface ValidateCtx {
  push(d: Diagnostic): void;
  pos: Pos;
  resolveBlock?: (name: string) => Workflow | undefined;
  allIds: Set<string>;
  /** The diagnostics of a block file validated on its own (as `block: true`); a host that cannot leaves it out. */
  checkBlock?(w: Workflow): Diagnostic[];
}
/** What `validate.program` sees: the compiled program and which track each step runs in. */
export interface ProgramCtx extends ValidateCtx {
  readonly program: readonly Instr[];
  /** The step id a track starts at, for a step that runs in that track; undefined on the main line. */
  trackOf(stepId: string): string | undefined;
  /** The step ids of the track that starts at `start`, in program order; with `nested`, also those of every track started inside it. */
  members(start: string, nested?: boolean): string[];
}
/** Which mod a node came from and the events it declared (`provides.events`). Only the loader sets it, on its frozen copy; `register` then stores the guarded node (guard.ts). */
export interface ModInfo { readonly id: string; readonly events: readonly string[]; /** A block of the default pack (set by the loader from a bundled manifest): its heading text and default id are not cut. */ readonly pack?: true }
export interface NodeType {
  mod?: ModInfo;
  kind: string;
  attrs: string[];
  container?: 'kids' | 'kids+else';
  /** True when the step can fail, so an on-fail link on it can fire. */
  fails?: true;
  /** The kind takes several `next` links and compiles them itself: core adds no JUMP for them, and the one-`next` rule skips it. `on-fail` stays single. */
  manyNext?: true;
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
    /** Runs last, only on a workflow with no error so far. */
    program?(step: Step, ctx: ProgramCtx): void;
  };
  compile(step: Step, ctx: CompileCtx): void;
  /** The ops this kind compiles to (the instruction's `op` name is the key). Op names stay as they are, so compiled programs keep their bytes. */
  ops?: Record<string, OpType<any>>;
  /** Runs this kind's NODE instruction (P12): 'next' moves on; 'stay' leaves the counter (the run paused or stopped). */
  exec?(step: Step, ctx: ExecCtx): Promise<'next' | 'stay'>;
  /**
   * Events of this kind that the receipt counts: the name returned is the count's key (e.g. 'hops'), or one of the receipt's fixed fields
   * (`gatesHeld`, `loopAttempts`, `verifyResults.passed`, `verifyResults.failed`, `knowlRecalls`, `knowlStores`, `knowlSkipped`), which it then adds one to.
   */
  count?: Partial<Record<RunEventType, (data: any) => string | undefined>>;
  /** Events of this kind that `reins run` prints: the line returned replaces the default print; undefined leaves it. */
  print?: Partial<Record<RunEventType, (data: any) => string | undefined>>;
  defaultPrompt?(step: Step): string | undefined;
  statusLine?: string;
  /** True on the kind a chat message is wrapped in: the chat's tags build `## <kind> prompt` and read this kind's `attrs` as attribute tags. The first such kind in `order` is used. */
  chatTurn?: true;
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
  readonly tracks: {
    /** Starts the tracks in order and parks this track on its instruction until every one ended; then this op runs again. Throws when `group` is in use or a key is live. */
    start(group: string, list: TrackSpec[]): void;
    /** Once every track of `group` ended: their results in start order, and the group is forgotten. Undefined when never started or not all ended. */
    take(group: string): TrackResult[] | undefined;
  };
  /** The next turn of this track carries `text` (the caller quotes it). */
  handBack(text: string): void;
  /** This track's last reply, read live. */
  lastReply(): string | undefined;
}

export interface TrackSpec {
  /** Unique among live tracks. */
  key: string;
  /** The instruction the track starts at. */
  at: number;
  /** Card and receipt title. */
  title: string;
  /** Texts its first turn carries (the caller quotes them). */
  seed?: string[];
  /** Shares the USD room equally with the other tracks of the same `start` that say so (spec 4.6). No room (no workflow limit, no open slice): no share. */
  share?: true;
}
export interface TrackResult { key: string; title: string; text: string; cost: number }

/** A kind's own instruction: `exec` runs it again from the start after a pause or crash. */
export interface OpType<I extends Instr> {
  exec(instr: I, vm: VmCtx): Promise<void>;
  /** Where the reach walk goes from here (undefined: no such place); replaces `[at + 1]`. */
  next?(instr: I, at: number): Array<number | undefined>;
  /** The instructions where this op starts tracks. `next` lists them too (whole reach); the main-line walk follows `next` minus these. */
  starts?(instr: I): number[];
  /** The commands the instruction runs on its own, for the trust hash. */
  commands?(instr: I): string[];
  /** Where "Allow more" sends the run back to for an instruction that paused for its budget (undefined: nowhere). */
  allowMore?(instr: I): number | undefined;
  /** The instruction runs a command whose result the conditions read right after (`EvalCtx.atRun`). */
  ranCommand?: true;
  /**
   * The instruction sits in the body of a loop that ends on a condition (`CompileCtx.loopBody`): the fields of this instruction it takes (never `op`, `step` or `top`), or undefined to take none.
   * `passes`: it is the first instruction of the body, its block runs a command (`ranCommand`), and the loop's condition is that command passing.
   */
  inLoop?(instr: I, loop: { cond: Cond; exit: number; passes: boolean }): Partial<I> | undefined;
}

/** The instructions the run itself executes: a kind cannot bring these. */
export const CORE_OPS = ['TURN', 'JUMP', 'END', 'NODE'];

const KINDS = ordered<NodeType>('kind', (n) => n.kind);
/** The kinds in `order` (ties by arrival). Read it; add and remove with `register`. */
export const NODES = KINDS.map;

/**
 * Adds a kind and the ops it brings, at `order` (none: after every other). Throws on a known kind, a core op or a taken op,
 * and then adds nothing. With `shadow`, a known kind is covered instead (its own ops are not "taken"); the disposer brings
 * it back. Returns a function that removes the entry again; a second call does nothing.
 */
export function register(given: NodeType, order?: number, opts?: { shadow?: boolean }): () => void {
  const n = given.mod ? guardNode(given) : given;   // a mod's node is stored as the guarded copy
  if (NODES.has(n.kind) && !opts?.shadow) throw new Error(`kind "${n.kind}" is already registered`);
  for (const op of Object.keys(n.ops ?? {})) {
    if (CORE_OPS.includes(op)) throw new Error(`op "${op}" is a core op`);
    const owner = [...NODES.values()].find((k) => k.ops && Object.hasOwn(k.ops, op));
    if (owner && owner.kind !== n.kind) throw new Error(`op "${op}" is already brought by kind "${owner.kind}"`);
  }
  return KINDS.add(n, { order, shadow: opts?.shadow });
}
// The numbers are today's order, with room between them.
for (const [n, order] of [[use, 80]] as const) register(n, order);

export function opOf(op: string): OpType<any> | undefined {
  for (const n of NODES.values()) if (n.ops && Object.hasOwn(n.ops, op)) return n.ops[op];
  return undefined;
}

export function defaultId(step: { kind: string; title?: string }, counters: Record<string, number>): string {
  const own = NODES.get(step.kind)?.defaultId?.(step as Step);
  if (own) return own;
  const n = (Object.hasOwn(counters, step.kind) ? counters[step.kind]! : 0) + 1;   // a kind named `constructor` must not find an Object member
  counters[step.kind] = n;
  return `${step.kind}-${n}`;
}
export function nodeAttrs(): Set<string> { return new Set([...NODES.values()].flatMap((n) => n.attrs)); }
export function headingOwns(): Set<string> { return new Set([...NODES.values()].flatMap((n) => n.heading?.owns ?? [])); }

export { checkMode, turnInstr, policyOf } from './turn.js';
export { default as useNode } from './use.js';
