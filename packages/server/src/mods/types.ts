import type { CardType, CondType, Decision, Engine, EngineEvent, EngineProbe, NodeType, ToolRequest, checkMode, driftFound, globMatcher, isValidGlob, parseCond, policyOf, printCond, relPath, turnInstr } from '@reins/core';
import type { ModelRequest, WireEvent } from '../loop/types.js';
import type { KeyStatus } from '../secrets.js';
import type { Registry } from './registry.js';

export type ModSource = 'bundled' | 'user';

/** One thing wrong with one mod, in plain words (spec 5.5). It starts with the mod's id in backticks. */
export type Problem = string;

/**
 * Spec 7.8: the only function that attaches a key. `purpose` is the optional 4th argument: `'models'` (a model list or the probe) may skip
 * the consent question for a keyless provider; the default `'chat'` always asks. A wire passes `'models'` only from `listModels`.
 */
export type SendWithKey = (mod: ProviderManifest, url: string, init: RequestInit, purpose?: 'models' | 'chat') => Promise<Response>;

/** What a protocol is given to make an engine or probe one. Later tasks add `fetch` and `settings`. */
export interface EngineHost {
  model?: string;
  effort?: string;
  onApprove(r: ToolRequest): Promise<Decision>;
  onLive(e: EngineEvent): void;
  /** The injected env (cli.ts `io.env`), never `process.env` directly (spec S2). */
  env: NodeJS.ProcessEnv;
  /** The same scrubbed env as `shellEnv`, worked out when a helper process (taskkill, a probe's `--version`) starts. The provider's own process keeps `env`. */
  helperEnv?: () => NodeJS.ProcessEnv;
  /**
   * The env a shell command gets, worked out on EVERY call: `env` without the key names of the providers installed now, every REINS_* var,
   * and every var whose value holds a known secret. None: the loop's shell tool refuses to run.
   */
  shellEnv?: () => NodeJS.ProcessEnv;
  /** The Reins home (`<REINS_HOME>/.reins`). */
  home: string;
  /** The only way a key leaves Reins (spec 7.8). Optional on the type because the CLI protocol never sends; a wire throws a clear error without it. */
  send?: SendWithKey;
  /**
   * The host's sanitizer (the Redactor): a wire runs the whole message of every error it builds through it. With `max` the redacted text is
   * then cut to that length without leaving the start of a known secret (`redactCut`). Without one a wire leaves provider text out of its errors.
   */
  redact?: (text: string, max?: number) => string;
  /**
   * The same redaction of a WHOLE text, without the trim of an ending that could be the start of a key (`redact` always trims it, even when
   * nothing is cut). For a message that is complete: the loop's text, thinking, tool inputs and tool results. None: `redact` is used.
   */
  redactAll?: (text: string) => string;
  /** Whether a text holds a known secret value (raw or JSON-escaped). The shell env drops every variable whose value does. */
  holdsSecret?: (text: string) => boolean;
  /**
   * A new redactor for one stream that arrives in pieces (a `StreamRedactor`): `push` gives the text that is safe to show now (an ending that
   * could be the start of a key is held back), `end` gives what is left. For command output. None: the shell tool refuses to run.
   */
  redactStream?: () => { push(text: string): string; end(): string };
  /** The API agent loop's settings, read on every turn (a getter works). None: the defaults. */
  settings?: { maxCallsPerTurn: number };
  /** Whether the provider's key is set, missing, or not needed. Never the key. None: the loop does not check before a request. */
  key?(p: ProviderManifest): KeyStatus;
  /** The wire calls this for every chunk it receives (`parseSse`'s third argument): the loop's stall timer. The loop sets it per call. */
  heartbeat?: () => void;
}

/** The question a protocol wants answered before it starts a process in a folder, and what to say when it is not. */
export interface FolderTrust {
  hash: string;
  detail: string;
  prompt: string;
  /** The note and error when the answer is no. */
  refused: string;
  /** The note and error when the session was stopped while the question was open. */
  stopped: string;
  /** The key the answer is stored under, with the folder (`store.trust(cwd, key, hash)`). */
  key: string;
}

/** One call to a model API (spec 3.2). The wire turns the neutral request into its protocol and the stream back into events. */
export interface Wire {
  call(req: ModelRequest, p: ProviderManifest, h: EngineHost, signal: AbortSignal): AsyncIterable<WireEvent>;
  /**
   * THE model-list request of this wire: the manifest to send as (the wire's own key-header default included), the address (its fixed query
   * included) and the headers. `listModels`, Test connection and the sender's keyless exemption all read it, so none of them can drift.
   */
  listRequest?(p: ProviderManifest): { manifest: ProviderManifest; url: string; headers: Record<string, string> };
  /** Ids sorted; undefined on any failure (never throws). */
  listModels?(p: ProviderManifest, h: EngineHost, signal: AbortSignal): Promise<string[] | undefined>;
}

/**
 * What a protocol mod hands over. `'reins'`: Reins owns the history and the protocol is a wire. `'own'`: the engine keeps it (the CLI).
 * The members of the other variant are `?: undefined`, so `protocol.engine` and the like read as optional on the union.
 */
export type Protocol =
  | {
      id: string;
      conversation: 'reins';
      wire: Wire;
      engine?: undefined;
      probe?: undefined;
      folderTrust?: undefined;
    }
  | {
      id: string;
      conversation: 'own';
      wire?: undefined;
      capabilities: EngineProbe['capabilities'];
      engine(p: ProviderManifest, h: EngineHost): Engine;
      /** A probe opens no conversation, so it needs only the environment. */
      probe?(p: ProviderManifest, h: Pick<EngineHost, 'env' | 'helperEnv' | 'home'>): Promise<EngineProbe>;
      folderTrust?(cwd: string): FolderTrust | undefined;
    };

/**
 * What a code mod's default export (`activate(api)`) is given. It is built for one mod and limited to that mod's `provides`; every function
 * member throws once `activate` has settled. `core` is the curated helpers a block's own code needs later, so it stays callable.
 */
export interface ModApi {
  env: NodeJS.ProcessEnv;
  registerProtocol(p: Protocol): () => void;
  /** Block mods: adds a kind of step to core. Its view is the manifest's `view`, read before the code ran. */
  registerBlock(node: NodeType): () => void;
  /** Condition mods: adds a condition atom to core. */
  registerCondition(c: CondType): () => void;
  /** Card mods: adds a card kind to core. */
  registerCard(c: CardType): () => void;
  /** Exactly these three, frozen. It grows only by a reviewed edit; never `register`, `NODES`, `CONDS`, `CARDS` or `opOf`. */
  core: { checkMode: typeof checkMode; driftFound: typeof driftFound; globMatcher: typeof globMatcher; isValidGlob: typeof isValidGlob; parseCond: typeof parseCond; policyOf: typeof policyOf; printCond: typeof printCond; relPath: typeof relPath; turnInstr: typeof turnInstr };
}

/** What a mod says it brings. The api refuses anything not listed here. Each list is names. */
export interface Provides {
  /** Block mods: the kinds of step. */
  kinds?: string[];
  /** Block mods: the instruction names the kinds compile to. */
  ops?: string[];
  /** Block mods: the attributes a kind's body accepts, and the keys its heading owns. */
  attrs?: string[];
  /** Block mods: the run events its `count` and `print` tables and its ops name. */
  events?: string[];
  /** Condition mods: the condition atoms. */
  conditions?: string[];
  /** Card mods: the card kinds. */
  cards?: string[];
}

/** What a kind's `activate` is given. */
export interface ModHost {
  registry: Registry;
  env: NodeJS.ProcessEnv;
}

export interface Manifest {
  reins: 1;
  id: string;
  kind: string;
  version: string;
  label: string;
  description?: string;
  /** Bundled mods only (a user mod that says it is refused): the mod is part of the default pack, and Customize may copy it. */
  pack?: 'default';
  /** Bundled mods only: the mod cannot be switched off. */
  required?: true;
  /** Code mods only: a path inside the mod folder; the file default-exports `activate(api: ModApi): void`. */
  main?: string;
  /** Block, condition and card mods: what the mod brings (see `Provides`). */
  provides?: Provides;
  /** Block, condition and card mods: where the kind or atom sits in core's registry (a finite number). */
  order?: number;
  /** Block mods: the block's view as JSON, checked by the kind before any code runs. */
  view?: Record<string, unknown>;
  /** Data blocks (a block with no `main`): the prompt template, `{attr}` and `{a|b}` filled from the step's attributes. */
  turn?: string;
  /** Data blocks: the status line the step's reply ends with, one line. None: the default. */
  statusLine?: string;
}

export interface ProviderModel {
  id: string;
  label?: string;
  context?: number;
  maxOutput?: number;
  tools?: boolean;
  efforts?: string[];
  // `output` is optional: the Claude CLI reports its own cost, so its table holds only the input and cache-write prices.
  price?: { input: number; output?: number; cacheRead?: number; cacheWrite?: number };
  body?: Record<string, unknown>;
}

export interface ProviderManifest extends Manifest {
  kind: 'provider';
  protocol: string;
  baseUrl: string;
  /** The provider new sessions use when the user has not chosen one (`defaultProvider` setting). */
  default?: boolean;
  modelsUrl?: string;
  /** `style`: `bearer`, `header` (the header named in `header`) or `none`. */
  auth?: { style: string; keyEnv: string[]; header?: string };
  headers?: Record<string, string>;
  /** Where the model's reasoning text comes in the stream, and whether it is sent back on later assistant messages. */
  reasoning?: { field?: string; echo?: boolean };
  /** Deep-merged into every request body, under each model's `body` and the chosen effort's `body`. */
  body?: Record<string, unknown>;
  usage?: { streamOptions?: boolean };
  catalog?: string;
  defaultModel: string;
  price?: { input: number; output: number };
  models: ProviderModel[];
  efforts?: Array<{ id: string; label: string; body?: Record<string, unknown> }>;
  defaultEffort?: string;
  switchPrice?: string;
  /** What the provider bills a cache write at, as a multiple of the catalog's input price. */
  cacheWritePerInput?: number;
  untested?: boolean;
}

export interface ProtocolManifest extends Manifest {
  kind: 'protocol';
}

export interface LoadedMod {
  id: string;
  kind: string;
  source: ModSource;
  dir: string;
  enabled: boolean;
  hasCode: boolean;
  trusted: boolean;
  /** SHA-256 over the folder's files, for a mod with code. The trust prompt shows it. */
  hash?: string;
  replaces?: 'bundled';
  /** The `version` of the built-in this mod replaces (a user copy of a bundled mod). */
  builtinVersion?: string;
  /** Part of the default pack (a bundled mod that says so, or the user copy that replaces one). */
  pack?: 'default';
  /** The id cannot be switched off (a bundled mod that says `required`, and the user copy of it). */
  required?: true;
  problems: Problem[];
  manifest?: unknown;
}

/** A kind's own checks, run after the loader's common ones. `ctx.registry` holds the kinds loaded before this one. */
export interface ModKind {
  id: string;
  validate(raw: Record<string, unknown>, ctx: { id: string; registry: Registry; source?: ModSource; /** The manifest is a bundled mod's, or a user mod that has the id (and kind) of one: a copy of a built-in. */ builtin?: boolean }): Problem[];
  /** Records the mod; returns what undoes it. */
  activate(mod: LoadedMod, host: ModHost): (() => void) | undefined;
  /**
   * Runs for a mod with code that still needs trust, in place of `activate`: records what can be shown without running anything
   * (a block's view). Returns what undoes it.
   */
  preview?(mod: LoadedMod, host: ModHost): (() => void) | undefined;
  /** A mod with no code: what it registers, as a function of its manifest, run through the same api a code mod's `activate` gets. */
  data?(raw: Record<string, unknown>): ((api: ModApi) => void) | undefined;
  /** Kinds whose mods load before this kind's (a provider after protocol). */
  after?: string[];
  /** The mod's registrations in core take effect when the server starts, not live (block, condition, card). */
  startOnly?: true;
}

export interface LoadOptions {
  bundledDir: string;
  userDir: string;
  home: string;
  /** Ids the user switched off. */
  disabled: Set<string>;
  /** True when the trust record for this id holds this hash. */
  trusted: (id: string, hash: string) => boolean;
  env?: NodeJS.ProcessEnv;
  /** Runs after the folder was hashed and found trusted, before it is copied and its code is imported. */
  beforeActivate?: (mod: LoadedMod) => void;
  /** Tests only: runs after the mods folders were scanned, before any mod is loaded. */
  afterScan?: () => void;
  /**
   * What a `startOnly` kind's mods put in core, by `<kind>:<id>`, kept across loads by the caller (`startMods`). A mod found here is not activated again.
   * None: the mods of this load are undone by its own `dispose()`.
   */
  carry?: Map<string, Carried>;
}

/** One `startOnly` mod as it was when it registered in core, and what undoes that. */
export interface Carried {
  /** The manifest and code hash it registered under: a load that finds another says "applies after a restart". */
  sig: string;
  manifest: Record<string, unknown>;
  source: ModSource;
  dir: string;
  hasCode: boolean;
  hash?: string;
  /** Its registrations in core. */
  undo: Array<() => void>;
}

export interface Mods {
  mods: LoadedMod[];
  registry: Registry;
  /** Trouble with a whole mods folder (it could not be read), as opposed to one mod. */
  problems: Problem[];
  dispose(): void;
  /**
   * Reads the folders again and swaps `mods`, `registry` and `problems` in this same object, so everything holding it sees the new state.
   * A read with trouble in a whole folder keeps the old state; the problems come back. None when the loader was not started by `startMods`.
   */
  reload?(): Promise<Problem[]>;
  /** The hash of the code this process first ran for a mod id. Node cannot unload code, so a different hash waits for a restart. None: not started by `startMods`. */
  codeRan?(id: string): string | undefined;
}
