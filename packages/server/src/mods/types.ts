import type { Decision, Engine, EngineEvent, EngineProbe, ToolRequest } from '@reins/core';
import type { Registry } from './registry.js';

export type ModSource = 'bundled' | 'user';

/** One thing wrong with one mod, in plain words (spec 5.5). It starts with the mod's id in backticks. */
export type Problem = string;

/** What a protocol is given to make an engine or probe one. Later tasks add `send`, `fetch` and `settings`. */
export interface EngineHost {
  model?: string;
  effort?: string;
  onApprove(r: ToolRequest): Promise<Decision>;
  onLive(e: EngineEvent): void;
  /** The injected env (cli.ts `io.env`), never `process.env` directly (spec S2). */
  env: NodeJS.ProcessEnv;
  /** `env` without the installed key names and REINS_* (childEnv): what helper processes (taskkill) run with. The provider's own process keeps `env`. */
  helperEnv?: NodeJS.ProcessEnv;
  /** The Reins home (`<REINS_HOME>/.reins`). */
  home: string;
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

/** What a protocol mod hands over. Later tasks add the `conversation: 'reins'` wire members. */
export interface Protocol {
  id: string;
  /** `'own'`: the engine keeps the conversation (the CLI). */
  conversation: 'own';
  capabilities: EngineProbe['capabilities'];
  engine(p: ProviderManifest, h: EngineHost): Engine;
  /** A probe opens no conversation, so it needs only the environment. */
  probe?(p: ProviderManifest, h: Pick<EngineHost, 'env' | 'helperEnv' | 'home'>): Promise<EngineProbe>;
  folderTrust?(cwd: string): FolderTrust | undefined;
}

/** What a code mod's default export (`activate(api)`) is given. */
export interface ModApi {
  env: NodeJS.ProcessEnv;
  registerProtocol(p: Protocol): () => void;
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
  /** Code mods only: a path inside the mod folder; the file default-exports `activate(api: ModApi): void`. */
  main?: string;
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
  auth?: { style: string; keyEnv: string[] };
  headers?: Record<string, string>;
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
  problems: Problem[];
  manifest?: unknown;
}

/** A kind's own checks, run after the loader's common ones. `ctx.registry` holds the kinds loaded before this one. */
export interface ModKind {
  id: string;
  validate(raw: Record<string, unknown>, ctx: { id: string; registry: Registry }): Problem[];
  /** Records the mod; returns what undoes it. */
  activate(mod: LoadedMod, host: ModHost): (() => void) | undefined;
  /** Kinds whose mods load before this kind's (a provider after protocol). */
  after?: string[];
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
  /** Tests only: runs after the folder was hashed, before it is copied and its code is imported. */
  beforeActivate?: (mod: LoadedMod) => void;
  /** Tests only: runs after the mods folders were scanned, before any mod is loaded. */
  afterScan?: () => void;
}

export interface Mods {
  mods: LoadedMod[];
  registry: Registry;
  /** Trouble with a whole mods folder (it could not be read), as opposed to one mod. */
  problems: Problem[];
  dispose(): void;
}
