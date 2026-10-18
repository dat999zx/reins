import type { Registry } from './registry.js';

export type ModSource = 'bundled' | 'user';

/** One thing wrong with one mod, in plain words (spec 5.5). It starts with the mod's id in backticks. */
export type Problem = string;

/** What a protocol mod hands over. Later tasks add the wire members. */
export interface Protocol {
  id: string;
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
  price?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  body?: Record<string, unknown>;
}

export interface ProviderManifest extends Manifest {
  kind: 'provider';
  protocol: string;
  baseUrl: string;
  modelsUrl?: string;
  auth?: { style: string; keyEnv: string[] };
  headers?: Record<string, string>;
  catalog?: string;
  defaultModel: string;
  price?: { input: number; output: number };
  models: ProviderModel[];
  efforts?: Array<{ id: string; label: string; body?: Record<string, unknown> }>;
  defaultEffort?: string;
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
