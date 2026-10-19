import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineProbe } from '@reins/core';
import { loadMods } from './mods/loader.js';
import { loopEngine } from './loop/engine.js';
import { childEnv, envGet, keyStatus, readSecrets, Redactor, redactCut } from './secrets.js';
import { makeSend } from './send.js';
import type { EngineHost, LoadedMod, Mods, Protocol, ProviderManifest, SendWithKey } from './mods/types.js';
import type { MakeEngine, SessionDeps } from './session.js';

/** The bundled mods: the folder this code sits in, `src/mods` under tests and `dist/mods` in the build. */
export const BUNDLED_MODS = fileURLToPath(new URL('./mods/', import.meta.url));

/** Loads the bundled mods and the user's (`<dir>/mods`). `dir` is the Reins folder (`~/.reins`). */
export const startMods = (o: { dir: string; env: NodeJS.ProcessEnv }): Promise<Mods> =>
  // ponytail: nothing is switched off and no code is trusted yet; settings and the trust store come with the settings tasks.
  loadMods({ bundledDir: BUNDLED_MODS, userDir: path.join(o.dir, 'mods'), home: o.dir, disabled: new Set(), trusted: () => false, env: o.env });

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

/**
 * The `send` a production host carries. Consent is refused for now, so nothing is sent by accident; Task 21 replaces the callback
 * with the consent store. Built on first use: a session that never sends reads no secrets.
 */
export function hostSend(mods: Mods, base: Pick<EngineHost, 'env' | 'home'>): Pick<EngineHost, 'send' | 'redact' | 'redactAll' | 'key'> {
  let redactor: Redactor | undefined;
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
  const lazy = { redact: (t: string) => get().redact(t), has: (t: string) => get().has(t), safeLength: (t: string) => get().safeLength(t) };
  let send: SendWithKey | undefined;
  return {
    // Only the state ever leaves: never the key, nor the env var it came from.
    key: (p) => ({ state: keyStatus(p, readSecrets(base.home), base.env).state }),
    redact: (t, max) => redactCut(lazy, t, max),
    redactAll: (t) => lazy.redact(t),
    send: (m, url, init, purpose) => {
      send ??= makeSend({ secrets: () => readSecrets(base.home), env: base.env, redactor: lazy, consent: () => false });
      return send(m, url, init, purpose);
    },
  };
}

/** The engine factory sessions use. Synchronous: a session's microtask order depends on it. */
export function makeEngineFrom(mods: Mods, base: Pick<EngineHost, 'env' | 'home' | 'send' | 'redact'>): MakeEngine {
  return ({ provider, ...rest }) => {
    const found = resolve(mods, provider);
    if (!found) throw new Error(`The provider "${provider}" is not installed.`);
    const host = { ...hostSend(mods, base), ...base, helperEnv: childEnv(base.env, keyEnvNames(mods)), ...rest };
    // A 'reins' protocol is a wire: Reins owns the conversation and runs it in the API agent loop.
    if (found.protocol.conversation === 'reins') return loopEngine(found.manifest, found.protocol.wire, host);
    return found.protocol.engine(found.manifest, host);
  };
}

export async function probeFrom(mods: Mods, provider: string, base: Pick<EngineHost, 'env' | 'home'>): Promise<EngineProbe> {
  const found = resolve(mods, provider);
  if (found?.protocol.conversation === 'reins') {
    const host = { ...hostSend(mods, base), ...base, onApprove: async () => ({ behavior: 'deny' as const }), onLive: () => {} };
    return loopEngine(found.manifest, found.protocol.wire, host).probe();
  }
  if (!found?.protocol.probe) throw new Error(`The provider "${provider}" cannot be probed.`);
  return found.protocol.probe(found.manifest, { ...base, helperEnv: childEnv(base.env, keyEnvNames(mods)) });
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
    }];
  });
