import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineProbe } from '@reins/core';
import { modTrusted, readDisabled, sweepScratch } from './mods/actions.js';
import { loadMods } from './mods/loader.js';
import { loopEngine } from './loop/engine.js';
import { childEnv, envGet, keyStatus, readSecrets, Redactor, redactCut, StreamRedactor } from './secrets.js';
import { makeSend } from './send.js';
import type { EngineHost, LoadedMod, Mods, Protocol, ProviderManifest, SendWithKey } from './mods/types.js';
import type { CheckEnv, ProviderFacts } from './run-checks.js';
import type { MakeEngine, SessionDeps } from './session.js';
import type { Store } from './store.js';

/** The bundled mods: the folder this code sits in, `src/mods` under tests and `dist/mods` in the build. */
export const BUNDLED_MODS = fileURLToPath(new URL('./mods/', import.meta.url));

/** The providers the first-run list and Settings offer to install: `packages/server/catalog`, beside `src` and `dist`. */
export const CATALOG_DIR = fileURLToPath(new URL('../catalog/', import.meta.url));

/**
 * Loads the bundled mods and the user's (`<dir>/mods`). `dir` is the Reins folder (`~/.reins`). The result can `reload()`: it reads the folders
 * and the on/off list again and swaps the new state into the same object. One reload at a time.
 * A code mod runs only when `<dir>/mod-trust.json` holds the hash of its files (spec 5.4). Node cannot unload code, so once a hash has run for an id,
 * a different hash is not run until the process restarts (`codeRan` tells Settings).
 */
export async function startMods(o: { dir: string; env: NodeJS.ProcessEnv }): Promise<Mods> {
  const ran = new Map<string, string>();
  const load = () => loadMods({
    bundledDir: BUNDLED_MODS, userDir: path.join(o.dir, 'mods'), home: o.dir, disabled: readDisabled(o.dir), env: o.env,
    trusted: (id, hash) => (ran.get(id) ?? hash) === hash && modTrusted(o.dir, id, hash),
    beforeActivate: (m) => { if (m.hash !== undefined && !ran.has(m.id)) ran.set(m.id, m.hash); },
  });
  // A crash in the middle of an import left folders in the home: undo them before anything loads (once per process).
  const swept = sweepScratch(o.dir);
  let inner = await load();
  let tail: Promise<unknown> = Promise.resolve();
  const live: Mods = {
    mods: inner.mods, registry: inner.registry, problems: [...swept, ...inner.problems],
    dispose: () => inner.dispose(),
    codeRan: (id) => ran.get(id),
    reload: () => (tail = tail.catch(() => {}).then(async () => {
      const next = await load();
      // Trouble with a whole folder (it could not be read): what ran before stays, and the words come back.
      if (next.problems.length) {
        next.dispose();
        return next.problems;
      }
      const old = inner;
      inner = next;
      live.mods = next.mods;
      live.registry = next.registry;
      live.problems = next.problems;
      old.dispose();
      return [];
    })) as Promise<string[]>,
  };
  return live;
}

const manifestOf = (mods: Mods, provider: string) => mods.registry.get<LoadedMod>('provider', provider)?.manifest as ProviderManifest | undefined;

/** The provider's manifest and its protocol, or undefined when either is not installed. */
function resolve(mods: Mods, provider: string): { manifest: ProviderManifest; protocol: Protocol } | undefined {
  const manifest = manifestOf(mods, provider);
  const protocol = manifest && mods.registry.get<Protocol>('protocol-impl', manifest.protocol);
  return manifest && protocol ? { manifest, protocol } : undefined;
}

/** Every env var name any installed provider asks for its key (`auth.keyEnv`): the names `childEnv` drops and the redactor reads. */
export const keyEnvNames = (mods: Mods): string[] =>
  [...new Set(mods.registry.ids('provider').flatMap((id) => manifestOf(mods, id)?.auth?.keyEnv ?? []))];

/**
 * Every env var name that ANY scanned manifest lists in `auth.keyEnv`, including a mod that was rejected (its problem line can echo
 * the value) and a name that fails the key-name pattern. Only the redactor uses this: a rejected mod must not take a variable
 * away from workflow commands, so `childEnv` takes `keyEnvNames` above.
 */
export const redactEnvNames = (mods: Mods): string[] => {
  const names = new Set<string>(keyEnvNames(mods));
  for (const m of mods.mods) {
    const list = (m.manifest as { auth?: { keyEnv?: unknown } } | undefined)?.auth?.keyEnv;
    if (Array.isArray(list)) for (const n of list) if (typeof n === 'string' && n !== '' && n.length <= 200) names.add(n);
  }
  return [...names];
};

/** Whether the user said yes to sending prompts and the key to this origin for this provider id (the store's `hasConsent`). */
export type ConsentCheck = (modId: string, origin: string) => boolean;

/**
 * The `send` a production host carries. `consent` is the store's check; the default says no, so a host built without one sends nothing.
 * Built on first use: a session that never sends reads no secrets.
 */
export function hostSend(mods: Mods, base: Pick<EngineHost, 'env' | 'home'>, consent: ConsentCheck = () => false, shared?: Redactor): Pick<EngineHost, 'send' | 'redact' | 'redactAll' | 'redactStream' | 'holdsSecret' | 'key'> {
  // `shared`: the process's own Redactor (the store's). One per process, so a key retired in it stays masked in every engine's files and tool results;
  // without one (a test that builds a host by hand) this host makes its own.
  let redactor: Redactor | undefined = shared;
  let seen = '';
  // The key names and the env values they hold, as one string compared on every call (cheap): a key set or changed in the env after the
  // start, or a provider installed later, makes the Redactor read the env and the names again. The secrets file it already watches itself.
  const envStamp = () => {
    const names = redactEnvNames(mods);
    return JSON.stringify([names, names.map((n) => envGet(base.env, n))]);
  };
  const get = () => {
    const now = envStamp();
    if (!redactor) redactor = new Redactor({ home: base.home, env: base.env, keyEnvNames: () => redactEnvNames(mods) });
    else if (now !== seen) redactor.refresh();
    seen = now;
    return redactor;
  };
  const lazy = { redact: (t: string) => get().redact(t), has: (t: string) => get().has(t), safeLength: (t: string) => get().safeLength(t), learn: (v: string, n: string) => get().learn(v, n), hold: (v: string, n: string) => get().hold(v, n) };
  let send: SendWithKey | undefined;
  return {
    // Only the state ever leaves: never the key, nor the env var it came from.
    key: (p) => ({ state: keyStatus(p, readSecrets(base.home), base.env).state }),
    redact: (t, max) => redactCut(lazy, t, max),
    redactAll: (t) => lazy.redact(t),
    redactStream: () => new StreamRedactor(lazy),
    holdsSecret: (t) => lazy.has(t),
    send: (m, url, init, purpose) => {
      send ??= makeSend({ secrets: () => readSecrets(base.home), env: base.env, redactor: lazy, consent, consentNow: consent,
        // The registry is read at every send: an engine opened before a reload keeps its old manifest, but never sends by it.
        current: (id) => manifestOf(mods, id),
        listUrl: (m) => resolve(mods, m.id)?.protocol.wire?.listRequest?.(m).url,
      });
      return send(m, url, init, purpose);
    },
  };
}

/** The key variable names of every provider that loaded, switched off ones too: a provider that is off can be switched on again, and its variable is still its key. */
const knownKeyEnvNames = (mods: Mods): string[] => {
  const names = new Set(keyEnvNames(mods));
  for (const m of mods.mods) {
    if (m.kind !== 'provider' || m.problems.length) continue;
    const list = (m.manifest as { auth?: { keyEnv?: unknown } } | undefined)?.auth?.keyEnv;
    if (Array.isArray(list)) for (const n of list) if (typeof n === 'string' && n !== '') names.add(n);
  }
  return [...names];
};

/**
 * THE env of every child Reins starts for the user's work or for itself (the shell tool, workflow commands, git, the folder dialog, the browser
 * launcher, kill helpers), worked out when the child starts, never before: `childEnv` for every provider known NOW (a switched-off one too), no
 * REINS_* variable, and no variable whose value holds a known secret (an alias of a key, or a key inside a longer value such as a Path).
 * ponytail: nothing else is taken out. BASH_ENV, NODE_OPTIONS and PSModulePath are the user's own and stay: a shell is not a sandbox, and the real
 * guard is the approval.
 */
export const shellEnvFrom = (mods: Mods, env: NodeJS.ProcessEnv, holdsSecret: (t: string) => boolean) => (): NodeJS.ProcessEnv => {
  const clean = childEnv(env, knownKeyEnvNames(mods));
  for (const [k, v] of Object.entries(clean)) if (v !== undefined && holdsSecret(v)) delete clean[k];
  return clean;
};

/** The engine factory sessions use. Synchronous: a session's microtask order depends on it. */
export function makeEngineFrom(mods: Mods, base: Pick<EngineHost, 'env' | 'home' | 'send' | 'redact'>, consent?: ConsentCheck, redactor?: Redactor): MakeEngine {
  return ({ provider, ...rest }) => {
    const found = resolve(mods, provider);
    if (!found) throw new Error(`The provider "${provider}" is not installed.`);
    const sent = hostSend(mods, base, consent, redactor);
    const children = shellEnvFrom(mods, base.env, sent.holdsSecret!);
    const host = { ...sent, ...base, helperEnv: children, shellEnv: children, ...rest };
    // A 'reins' protocol is a wire: Reins owns the conversation and runs it in the API agent loop.
    if (found.protocol.conversation === 'reins') return loopEngine(found.manifest, found.protocol.wire, host);
    return found.protocol.engine(found.manifest, host);
  };
}

/**
 * What the live model lists (`live-models.ts`) read of the installed providers: the list through the provider's wire, which sends only through
 * `host.send` (spec 7.8), and whether the provider needs a key. A provider whose protocol has no list (the CLI) fetches nothing.
 */
export const liveListSource = (mods: Mods, host: Pick<EngineHost, 'env' | 'home' | 'send' | 'redact'>) => ({
  fetchIds: (provider: string, signal: AbortSignal): Promise<string[] | undefined> | undefined => {
    const found = resolve(mods, provider);
    const wire = found?.protocol.wire;
    if (!found || !wire?.listModels) return undefined;
    return wire.listModels(found.manifest, { ...host, onApprove: async () => ({ behavior: 'deny' as const }), onLive: () => {} }, signal);
  },
  keyless: (provider: string): boolean => {
    const auth = manifestOf(mods, provider)?.auth;
    return !auth || auth.style === 'none';
  },
});

export async function probeFrom(mods: Mods, provider: string, base: Pick<EngineHost, 'env' | 'home'>, redactor?: Redactor): Promise<EngineProbe> {
  const found = resolve(mods, provider);
  const sent = hostSend(mods, base, undefined, redactor);
  if (found?.protocol.conversation === 'reins') {
    const host = { ...sent, ...base, onApprove: async () => ({ behavior: 'deny' as const }), onLive: () => {} };
    return loopEngine(found.manifest, found.protocol.wire, host).probe();
  }
  if (!found?.protocol.probe) throw new Error(`The provider "${provider}" cannot be probed.`);
  return found.protocol.probe(found.manifest, { ...base, helperEnv: shellEnvFrom(mods, base.env, sent.holdsSecret!) });
}

/**
 * What the run-start checks (spec 10.2) read of the installed providers, worked out on every call: the key state is read from the secrets file
 * and the env as they are now. A provider counts as installed when its manifest and its protocol are both loaded and enabled.
 * ponytail: a model is priced when its table row or the provider's default price has an output price (what the loop bills with); the catalog is not read.
 */
export const checkEnvFrom = (mods: Mods, base: Pick<EngineHost, 'env' | 'home'>): Pick<CheckEnv, 'installed' | 'facts'> => {
  const facts = (id: string): ProviderFacts | undefined => {
    const found = resolve(mods, id);
    if (!found) return undefined;
    const { manifest: m, protocol } = found;
    return {
      id: m.id, label: m.label, conversation: protocol.conversation,
      key: keyStatus(m, readSecrets(base.home), base.env).state,
      keyEnv: m.auth?.keyEnv ?? [],
      defaultModel: m.defaultModel,
      model: (model) => {
        const x = m.models.find((v) => v.id === model);
        return { tools: x?.tools !== false, efforts: x?.efforts ?? (m.efforts ?? []).map((e) => e.id), priced: x?.price?.output !== undefined || m.price !== undefined };
      },
    };
  };
  return { installed: (id) => resolve(mods, id) !== undefined, facts };
};

/** The origin of an address (`https://host:port`), or undefined when it is not one. Consent is kept per this, never per the whole address. */
export const originOf = (address: string): string | undefined => {
  try {
    const u = new URL(address);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
};

/** Whether Reins itself sends to this provider (a wire protocol), and so needs the user's yes first; the CLI provider talks for itself. */
export const sendsFromReins = (mods: Mods, provider: string): boolean => resolve(mods, provider)?.protocol.conversation === 'reins';

/** The origin of the provider's base address as installed NOW; undefined when it is gone, switched off, or Reins sends nothing to it. */
export const providerOrigin = (mods: Mods, provider: string): string | undefined => {
  const found = resolve(mods, provider);
  return found?.protocol.conversation === 'reins' ? originOf(found.manifest.baseUrl) : undefined;
};

/**
 * Spec 7.8: the question a session asks before the first reply on a provider whose CURRENT origin has no yes in the store (keyed or keyless alike).
 * undefined = the yes is recorded, or Reins sends nothing to this provider. A yes records (provider id, origin) as the manifest names them now.
 */
export function consentFrom(mods: Mods, store: Pick<Store, 'hasConsent' | 'grantConsent'>): NonNullable<SessionDeps['consent']> {
  return (provider) => {
    const found = resolve(mods, provider);
    if (!found || found.protocol.conversation !== 'reins') return undefined;
    const m = found.manifest;
    const origin = originOf(m.baseUrl);
    if (origin === undefined || store.hasConsent(m.id, origin)) return undefined;
    // The yes is for the origin the question showed. It is recorded only if the provider still has that origin when the answer comes.
    const grant = () => {
      if (providerOrigin(mods, provider) !== origin) return false;
      store.grantConsent(m.id, origin);
      return true;
    };
    const host = new URL(origin).host;
    const keyed = !!m.auth && m.auth.style !== 'none';
    return {
      prompt: keyed
        ? `This session sends your prompts, the files the agent reads, and your key to ${host}. Go on? [y / n]`
        : `This session sends your prompts and the files the agent reads to ${host}. Go on? [y / n]`,
      detail: `${m.label}: ${origin}${origin.startsWith('http:') ? ' (plain http, not encrypted)' : ''}`,
      refused: `Nothing was sent: you did not allow ${host}.`,
      stopped: `The session was stopped before you answered, so nothing was sent to ${host}.`,
      grant,
    };
  };
}

export const folderTrustFrom = (mods: Mods): NonNullable<SessionDeps['folderTrust']> =>
  (provider, cwd) => resolve(mods, provider)?.protocol.folderTrust?.(cwd);

/** A provider as the picker, the header and the price lookups read it. */
export interface ProviderView {
  id: string;
  label: string;
  defaultModel: string;
  defaultEffort: string;
  efforts: Array<{ id: string; label: string }>;
  /** The curated models, in picker order. */
  models: Array<{ id: string; label: string }>;
  catalog?: string;
  /** The manifest asks to be the default provider. */
  default?: boolean;
  /** USD per million tokens, as the provider bills them. */
  prices: Record<string, { input: number; cacheWrite?: number }>;
  cacheWritePerInput?: number;
  /** The provider's default price for a model with no row of its own. */
  price?: { input: number; output?: number };
}

/** The provider new sessions use: the one the user chose (`defaultProvider` setting) if installed, else the one whose manifest says `default`, else the first installed. */
export const defaultProviderOf = (views: ProviderView[], chosen: string): ProviderView | undefined =>
  views.find((p) => p.id === chosen) ?? views.find((p) => p.default) ?? views[0];

/** Every installed provider, by id. */
export const providerViews = (mods: Mods): ProviderView[] =>
  mods.registry.ids('provider').flatMap((id) => {
    const m = manifestOf(mods, id);
    if (!m) return [];
    return [{
      id: m.id, label: m.label, defaultModel: m.defaultModel, defaultEffort: m.defaultEffort ?? '',
      efforts: (m.efforts ?? []).map((e) => ({ id: e.id, label: e.label })),
      models: m.models.map((x) => ({ id: x.id, label: x.label ?? x.id })),
      ...(m.catalog ? { catalog: m.catalog } : {}),
      ...(m.default ? { default: true } : {}),
      prices: Object.fromEntries(m.models.flatMap((x) => (x.price ? [[x.id, { input: x.price.input, ...(x.price.cacheWrite !== undefined ? { cacheWrite: x.price.cacheWrite } : {}) }]] : []))),
      ...(m.cacheWritePerInput !== undefined ? { cacheWritePerInput: m.cacheWritePerInput } : {}),
      ...(m.price ? { price: { input: m.price.input, output: m.price.output } } : {}),
    }];
  });
