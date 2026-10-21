// The settings actions for provider mods (spec 7.3 to 7.5): list, install, custom, edit, enable, disable, remove, re-install.
// Plain functions over a Reins home and the loaded mods; the server only routes to them. Every manifest is checked with the loader's own
// `validateMod` before a byte is written, a file is written whole (temp file, then rename), and the loader is asked to read again after.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hasHiddenChars } from '@reins/core';
import { MIN_SECRET, clearKey, envGet, keyStatus, readSecrets, secretsFile, setKey, type KeyStatus } from '../secrets.js';
import { ConsentNeeded, ProviderChanged, ProviderError } from '../send.js';
import { readBounded } from '../loop/bounded.js';
import { classify, WORDS } from '../loop/retry.js';
import { modelIdsFrom } from '../loop/wire-util.js';
import { cleanIds } from '../live-models.js';
import { cap, show } from './kinds.js';
import { canonMain, caseAlias, hashFiles, isModId, parseManifest, readFolder, validateMod } from './loader.js';
import type { LoadedMod, Mods, Protocol, ProviderManifest, SendWithKey } from './types.js';

export type Reply = { status: number; body: unknown; headers?: Record<string, string> };
/** The yes answers of spec 7.8, kept per (provider id, origin) in the Reins store. */
export interface ConsentStore {
  has(id: string, origin: string): boolean;
  grant(id: string, origin: string): void;
  /** Every origin of the id. */
  revoke(id: string): void;
}
export interface ModEnv {
  /** The Reins folder (`~/.reins`). */
  home: string;
  /** `catalog/<id>/mod.json`, the providers the chooser offers. May not exist. */
  catalogDir: string;
  mods: Mods;
  consent: ConsentStore;
  /** The only function that attaches a key (spec 7.8). Test connection sends through it and nothing else. */
  send: SendWithKey;
  /** The env a key variable is looked up in (the server's injected one). */
  env: NodeJS.ProcessEnv;
  /** The host's sanitizer, cut to `max`. */
  redact: (text: string, max?: number) => string;
  /** Whether a text holds a key Reins knows (the Redactor's `has`). Export refuses a file that does. */
  holdsSecret: (text: string) => boolean;
  /** How long Test connection waits for the provider. None: 8 seconds. */
  testTimeoutMs?: number;
}

const MAX_MANIFEST = 256 * 1024;
const fail = (status: number, error: string): Reply => ({ status, body: { error } });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const id$ = (id: string) => `\`${cap(id, 40)}\``;

const modsDir = (home: string) => path.join(home, 'mods');
const disabledFile = (home: string) => path.join(home, 'disabled-mods.json');
/** The marker `POST /api/mods/first-run/done` (Skip) and a first install write. */
export const firstRunFile = (home: string) => path.join(home, 'first-run-done');

/** The ids the user switched off. A missing or damaged file reads as none. */
export function readDisabled(home: string): Set<string> {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(disabledFile(home), 'utf8'));
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

const trustFile = (home: string) => path.join(home, 'mod-trust.json');
/** The code a user trusted: `{ "<mod id>": "<hash of all its files>" }`. One hash per id, so a changed file (or an old version) asks again. A missing or damaged file trusts nothing. */
function readTrust(home: string): Map<string, string> {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(trustFile(home), 'utf8'));
    return new Map(isObj(v) ? Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string') : []);
  } catch {
    return new Map();
  }
}
export const modTrusted = (home: string, id: string, hash: string) => readTrust(home).get(id) === hash;
function setTrust(home: string, id: string, hash: string | undefined) {
  const all = readTrust(home);
  if (hash === undefined ? !all.delete(id) : all.get(id) === hash) return;
  if (hash !== undefined) all.set(id, hash);
  writeWhole(home, trustFile(home), JSON.stringify(Object.fromEntries([...all].sort()), null, 2) + '\n');
}

// One change at a time per home: two edits of the same file, or a remove during an install, never interleave.
const tails = new Map<string, Promise<unknown>>();
function serial<T>(home: string, fn: () => Promise<T> | T): Promise<T> {
  const run = (tails.get(home) ?? Promise.resolve()).catch(() => {}).then(fn);
  tails.set(home, run);
  return run;
}

const scratch = (home: string, what: string) => path.join(home, `.mod-${what}-${process.pid}-${randomBytes(6).toString('hex')}`);
const quietRm = (p: string) => {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* a leftover temp name is harmless */ }
};
/** Removes a path; a link is removed itself, never what it points at. Returns a plain line (no home path) when it could not. */
function removeReport(p: string): string | undefined {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) {
      try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); }
    } else fs.rmSync(p, { recursive: true, force: true });
    return undefined;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? undefined : `could not remove ${path.basename(p)}`;
  }
}
const aliveElsewhere = (pid: number) => {
  if (pid === process.pid) return false; // a leftover of this very pid is from before this start
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException)?.code === 'EPERM'; }
};

/**
 * Once per start, before the mods load: undoes what a crash in the middle of an import left in the home. A staging folder or temp file
 * is deleted. A backup (`.mod-old-<id>-...`) goes back to `mods/<id>` when that is missing (the old install, with its old trust line), and is
 * deleted when the install is there. Nothing is followed: a link is removed itself. A leftover of a process that is still alive is left alone.
 * Returns plain lines for what it could not do.
 */
export function sweepScratch(home: string): string[] {
  const problems: string[] = [];
  let names: string[];
  try { names = fs.readdirSync(home).sort(); } catch { return problems; }
  for (const name of names) {
    const m = /^\.mod-(?:new|file|old-(.+))-(\d+)-[0-9a-f]{12}$/.exec(name);
    if (!m || aliveElsewhere(Number(m[2]))) continue;
    const p = path.join(home, name);
    const id = m[1];
    if (id !== undefined && isModId(id) && !there(path.join(modsDir(home), id))) {
      try {
        if (!fs.lstatSync(p).isDirectory()) throw new Error('not a folder'); // lstat: a link is not a folder
        fs.mkdirSync(modsDir(home), { recursive: true });
        fs.renameSync(p, path.join(modsDir(home), id));
        continue;
      } catch {
        const gone = removeReport(p);
        problems.push(gone ?? `could not restore ${id}`);
        continue;
      }
    }
    const gone = removeReport(p);
    if (gone) problems.push(gone);
  }
  return problems;
}

/** A temp file beside the target's home, then a rename over it: a reader sees the old file or the new one, never half. */
function writeWhole(home: string, file: string, text: string) {
  const tmp = scratch(home, 'file');
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) {
    quietRm(tmp);
    throw e;
  }
}

/** A new mod folder, built whole in the home and renamed into place: the mods folder never holds a half-made mod. */
function putFolder(home: string, id: string, manifestText: string) {
  const stage = scratch(home, 'new');
  try {
    fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, 'mod.json'), manifestText);
    fs.mkdirSync(modsDir(home), { recursive: true });
    fs.renameSync(stage, path.join(modsDir(home), id));
  } catch (e) {
    quietRm(stage);
    throw e;
  }
}

const there = (p: string) => {
  try { fs.lstatSync(p); return true; } catch { return false; }
};
/** The mod's folder when it is a real folder under the mods folder, else undefined. `id` has passed `isModId`. */
const folderOf = (home: string, id: string) => {
  const dir = path.join(modsDir(home), id);
  try { return fs.lstatSync(dir).isDirectory() ? dir : undefined; } catch { return undefined; }
};

function readCatalog(env: ModEnv, id: string): Record<string, unknown> | undefined {
  try {
    const file = path.join(env.catalogDir, id, 'mod.json');
    if (fs.statSync(file).size > MAX_MANIFEST) return undefined;
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObj(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}
const catalogIds = (env: ModEnv): string[] => {
  try {
    return fs.readdirSync(env.catalogDir, { withFileTypes: true }).filter((d) => d.isDirectory() && isModId(d.name)).map((d) => d.name).sort();
  } catch {
    return [];
  }
};

const bundledKinds = (mods: Mods) => new Map(mods.mods.filter((m) => m.source === 'bundled').map((m): [string, string] => [m.id, m.kind]));
/** What is wrong with a provider manifest that would be saved as `<mods>/<id>`, in plain words: the loader's checks plus the rules for data. */
function problemsOf(env: ModEnv, raw: Record<string, unknown>, id: string): string[] {
  const out = validateMod(raw, { folder: id, source: 'user' }, id, bundledKinds(env.mods), env.mods.registry);
  if (out.length) return out;
  if (raw.kind !== 'provider' || raw.main !== undefined) return [`${id$(id)}: only a provider with no code of its own can be added here.`];
  return addressProblems(raw, id);
}
/** A web address that carries a user name or password would sit in logs and the model list request. */
function addressProblems(raw: Record<string, unknown>, id: string): string[] {
  for (const k of ['baseUrl', 'modelsUrl'] as const) {
    const v = raw[k];
    try {
      if (typeof v === 'string' && (new URL(v).username || new URL(v).password)) return [`${id$(id)}: \`${k}\` must not hold a user name or password. Keys go in Settings > Providers, never in a mod.`];
    } catch { /* the validator worded it */ }
  }
  return [];
}
const refusal = (problems: string[]): Reply => ({ status: 400, body: { error: problems.join(' '), problems } });
/** Text a user wrote for a mod (a manifest, an import file) that holds a key Reins knows. The words never repeat it. */
const KEY_IN_MOD = 'That text holds a key Reins knows, so nothing was installed. Keys go in Settings > Providers, never in a mod file.';
/**
 * Whether any string VALUE or property NAME inside `v` holds a key Reins knows. Every string is looked at as it is, decoded, never inside the
 * JSON text of the container that holds it: a key with a backslash or a quote is written differently there (escaped again for every level) and a
 * search of that text would miss it. A structure nested deeper than a mod can be is refused.
 */
function holdsDeep(env: Pick<ModEnv, 'holdsSecret'>, v: unknown, depth = 0): boolean {
  if (typeof v === 'string') return env.holdsSecret(v);
  if (v === null || typeof v !== 'object') return false;
  if (depth > 100) return true;
  if (Array.isArray(v)) return v.some((x) => holdsDeep(env, x, depth + 1));
  return Object.entries(v).some(([k, x]) => env.holdsSecret(k) || holdsDeep(env, x, depth + 1));
}

/** Asks the loader to read again. A read that fails as a whole keeps what ran before; the words say so. */
async function reloaded(env: ModEnv, extra: Record<string, unknown> = {}): Promise<Reply> {
  let problems: string[];
  try {
    problems = (await env.mods.reload?.()) ?? [];
  } catch {
    problems = ['Reins could not read the mods folder again, so the change shows after a restart.'];
  }
  return { status: 200, body: { ok: true, ...extra, reloaded: problems.length === 0, ...(problems.length ? { problems } : {}) } };
}

const exists = (env: ModEnv, id: string) => env.mods.mods.some((m) => m.id === id) || there(path.join(modsDir(env.home), id));

// ---- GET /api/mods

/** The origin of a base address, or undefined when it is not an http(s) address. Consent is kept per this. */
const originOf = (address: unknown): string | undefined => {
  try {
    const u = new URL(String(address));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
};

/** An installed, enabled provider that Reins itself sends to (a wire protocol), with its protocol. The CLI provider is not one. */
function wireProvider(mods: Mods, id: string): { manifest: ProviderManifest; protocol: Extract<Protocol, { conversation: 'reins' }> } | undefined {
  const manifest = mods.registry.get<LoadedMod>('provider', id)?.manifest as ProviderManifest | undefined;
  const protocol = manifest && mods.registry.get<Protocol>('protocol-impl', manifest.protocol);
  return manifest && protocol?.conversation === 'reins' ? { manifest, protocol } : undefined;
}

/** What the settings page shows of a provider's key and consent: states only, never a value (spec 8.1). `needed` = no yes for the CURRENT origin. */
export function providerStatus(env: Pick<ModEnv, 'home' | 'mods' | 'consent' | 'env'>, id: string): { host: string; key: KeyStatus; consent: 'granted' | 'needed' } | undefined {
  const found = wireProvider(env.mods, id);
  const origin = found && originOf(found.manifest.baseUrl);
  if (!found || !origin) return undefined;
  return { host: new URL(origin).host, key: keyStatus(found.manifest, readSecrets(env.home), env.env), consent: env.consent.has(id, origin) ? 'granted' : 'needed' };
}

export type CodeTrust = 'none' | 'trusted' | 'needs-trust' | 'restart';
const RESTART = 'restart to run the new code';
/** Where a user mod stands with its code (spec 5.4): no code, running trusted code, waiting for a yes, or trusted but a restart away. */
function trustOf(env: Pick<ModEnv, 'home' | 'mods'>, m: LoadedMod): CodeTrust {
  if (!m.hasCode) return 'none';
  if (m.trusted) return 'trusted';
  const ran = env.mods.codeRan?.(m.id);
  return m.hash !== undefined && ran !== undefined && ran !== m.hash && modTrusted(env.home, m.id, m.hash) ? 'restart' : 'needs-trust';
}

function summary(env: ModEnv, m: LoadedMod) {
  const man = isObj(m.manifest) ? m.manifest : {};
  const trust = m.source === 'bundled' ? undefined : trustOf(env, m);
  return {
    ...(trust ? { trust } : {}),
    // A user mod with code: the hash the Trust button must name and the prompt that is shown first (see `trustMod`).
    ...(trust && trust !== 'none' && m.hash !== undefined ? { hash: m.hash, codePrompt: CODE_PROMPT } : {}),
    ...(m.kind === 'provider' ? providerStatus(env, m.id) : {}),
    // The manifest holds env var NAMES, never a key value (keys live in secrets.json); the settings page reads protocol, auth, models and untested from it.
    ...(m.kind === 'provider' && m.manifest !== undefined ? { manifest: m.manifest } : {}),
    id: m.id, kind: m.kind, label: typeof man.label === 'string' ? man.label : m.id, version: typeof man.version === 'string' ? man.version : '',
    enabled: m.enabled, bundled: m.source === 'bundled',
    // A user mod is "installed" when the catalog has that id (custom endpoints may not take a catalog id), else it is the user's own.
    source: m.source === 'bundled' ? 'bundled' : readCatalog(env, m.id) ? 'installed' : 'custom',
    ...(m.replaces ? { replaces: m.replaces } : {}),
    problems: trust === 'restart' ? [`${id$(m.id)}: ${RESTART}.`] : m.problems,
  };
}

const PROBE_MS = 1000;
/**
 * Whether a catalog entry is a program on this machine that is running: it needs no key, its address is localhost, 127.0.0.0/8 or ::1, and a
 * plain GET of its model list answers 2xx within a second. Any other address is never contacted. The request carries nothing but the default
 * headers (no key, no body, no cookies), a redirect is refused, and the answer's body is thrown away after the status. Any error is false.
 */
async function runsHere(raw: Record<string, unknown>): Promise<boolean> {
  if (!isObj(raw.auth) || raw.auth.style !== 'none') return false;
  try {
    const base = new URL(String(raw.baseUrl));
    const list = new URL(typeof raw.modelsUrl === 'string' ? raw.modelsUrl : `${String(raw.baseUrl).replace(/\/+$/, '')}/models`);
    for (const u of [base, list]) if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !isLocalHost(u.hostname) || u.username || u.password) return false;
    const res = await fetch(list, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(PROBE_MS) });
    void res.body?.cancel().catch(() => {});
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

/** The catalog providers not installed yet. `claude-code` is built in and never offered. `local`: it runs on this machine now (see `runsHere`). */
async function chooser(env: ModEnv, probe: boolean) {
  const entries = catalogIds(env).flatMap((id) => {
    const raw = readCatalog(env, id);
    if (!raw || id === 'claude-code' || exists(env, id) || problemsOf(env, raw, id).length) return [];
    const auth = isObj(raw.auth) && Array.isArray(raw.auth.keyEnv) ? raw.auth.keyEnv.filter((x): x is string => typeof x === 'string') : [];
    let host = '';
    try { host = new URL(String(raw.baseUrl)).host; } catch { /* validated above */ }
    return [{ raw, entry: {
      id, label: String(raw.label), description: typeof raw.description === 'string' ? raw.description : '',
      protocol: String(raw.protocol), host, keyEnv: auth, untested: raw.untested === true,
    } }];
  });
  // Only the first-run screen pre-ticks, so only then is anything asked of a local address.
  const up = probe ? await Promise.all(entries.map((e) => runsHere(e.raw))) : entries.map(() => false);
  return entries.map((e, i) => ({ ...e.entry, local: up[i]! }));
}

export async function listMods(env: ModEnv): Promise<Reply> {
  // First run: the marker was never written and no provider besides the built-in ones was installed.
  const firstRun = !there(firstRunFile(env.home)) && !env.mods.mods.some((m) => m.kind === 'provider' && m.source === 'user');
  return { status: 200, body: { mods: env.mods.mods.map((m) => summary(env, m)), firstRun, chooser: await chooser(env, firstRun), problems: env.mods.problems, secretsPath: secretsFile(env.home) } };
}

// ---- POST /api/mods/first-run/done

/** Writes the first-run marker and makes the mods folder (empty) when it is not there. Safe to repeat. */
function markFirstRunDone(home: string) {
  fs.mkdirSync(modsDir(home), { recursive: true });
  writeWhole(home, firstRunFile(home), '');
}

/** "Skip" of the first-run screen: the chooser is not shown again, and nothing is installed. */
export function firstRunDone(env: ModEnv): Promise<Reply> {
  return serial(env.home, () => {
    try {
      markFirstRunDone(env.home);
    } catch {
      return fail(500, 'Reins could not save that the first run is done.');
    }
    return { status: 200, body: { ok: true } };
  });
}

// ---- POST /api/mods/install

export function installMods(env: ModEnv, ids: unknown): Promise<Reply> {
  if (!Array.isArray(ids) || !ids.length || ids.length > 50 || !ids.every((i) => typeof i === 'string')) return Promise.resolve(fail(400, 'ids must be a list of provider ids.'));
  if (!catalogIds(env).length) return Promise.resolve(fail(404, 'This copy of Reins has no catalog of providers to install from.'));
  return serial(env.home, async () => {
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of [...new Set(ids as string[])]) {
      const no = (error: string) => results.push({ id: cap(id, 40), ok: false, error });
      if (!isModId(id)) { no(`${show(id)} is not a valid provider id.`); continue; }
      if (env.mods.mods.some((m) => m.id === id && m.source === 'bundled')) { no('is built in and always available.'); continue; }
      if (exists(env, id)) { no('is already installed. Use Re-install to replace your copy.'); continue; }
      const raw = readCatalog(env, id);
      if (!raw) { no('is not in the catalog.'); continue; }
      const problems = problemsOf(env, raw, id);
      if (problems.length) { no(problems.join(' ')); continue; }
      try {
        putFolder(env.home, id, fs.readFileSync(path.join(env.catalogDir, id, 'mod.json'), 'utf8'));
        results.push({ id, ok: true });
      } catch {
        no('could not be written. Nothing was added.');
      }
    }
    if (results.some((r) => r.ok)) {
      try { markFirstRunDone(env.home); } catch { /* the installed provider already ends the first run */ }
    }
    return reloaded(env, { results });
  });
}

// ---- POST /api/mods/custom

const CUSTOM = new Set(['id', 'label', 'description', 'baseUrl', 'modelsUrl', 'protocol', 'defaultModel', 'auth', 'models', 'price', 'efforts', 'defaultEffort', 'key']);
const KEY_WORDS = 'Keys go in Settings > Providers or the key field of a custom endpoint, never in a mod file.';
const hasControl = (s: string) => [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

function authOf(v: unknown): { auth: Record<string, unknown> } | { error: string } {
  if (!isObj(v) || (v.style !== 'bearer' && v.style !== 'header' && v.style !== 'none')) return { error: '`auth.style` must be bearer, header or none.' };
  const names = v.keyEnv === undefined ? [] : typeof v.keyEnv === 'string' ? [v.keyEnv] : v.keyEnv;
  if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) return { error: '`auth.keyEnv` must be an environment variable name, or a list of them.' };
  if (v.style === 'header' && (typeof v.header !== 'string' || !v.header.trim())) return { error: '`auth.header` must name the header that carries the key.' };
  return { auth: { style: v.style, keyEnv: v.style === 'none' ? [] : names, ...(v.style === 'header' ? { header: v.header } : {}) } };
}

export function addCustom(env: ModEnv, b: Record<string, unknown>): Promise<Reply> {
  for (const k of Object.keys(b)) if (!CUSTOM.has(k)) return Promise.resolve(fail(400, `\`${cap(k, 40)}\` is not a field of a custom endpoint.`));
  const { id, key } = b;
  if (!isModId(id)) return Promise.resolve(fail(400, 'The id must be lowercase letters, digits and dashes, start with a letter or digit, be at most 40 long, and not be a name Windows reserves.'));
  if (key !== undefined && (typeof key !== 'string' || hasControl(key))) return Promise.resolve(fail(400, 'The key must be text with no line breaks or control characters.'));
  if (typeof b.label !== 'string' || !b.label.trim()) return Promise.resolve(fail(400, '`label` is missing.'));
  const auth = authOf(b.auth ?? { style: 'none' });
  if ('error' in auth) return Promise.resolve(fail(400, auth.error));
  if (auth.auth.style === 'none' && key) return Promise.resolve(fail(400, 'A key was given but `auth.style` is none. Pick bearer or header.'));
  if (typeof key === 'string' && key.trim() && key.trim().length < MIN_SECRET) return Promise.resolve(fail(400, SHORT_KEY));
  if (typeof key === 'string' && key.length > MAX_KEY) return Promise.resolve(fail(400, `The key is longer than ${MAX_KEY} characters.`));
  const models = b.models ?? (typeof b.defaultModel === 'string' ? [{ id: b.defaultModel }] : undefined);
  const raw: Record<string, unknown> = { reins: 1, id, kind: 'provider', version: '1.0.0' };
  for (const k of ['label', 'description', 'protocol', 'baseUrl', 'modelsUrl', 'defaultModel', 'price', 'efforts', 'defaultEffort'] as const) if (b[k] !== undefined) raw[k] = b[k];
  raw.auth = auth.auth;
  if (models !== undefined) raw.models = models;
  return serial(env.home, async () => {
    // Before any check that could repeat a value, and before anything is written.
    if (holdsDeep(env, raw)) return fail(400, KEY_IN_MOD);
    if (exists(env, id) || catalogIds(env).includes(id)) return fail(409, `${id$(id)} already exists. Pick another id.`);
    const problems = problemsOf(env, raw, id);
    if (problems.length) return refusal(problems);
    const impl = env.mods.registry.get<Protocol>('protocol-impl', raw.protocol as string);
    if (impl?.conversation !== 'reins') return fail(400, `${id$(id)}: \`protocol\` ${show(raw.protocol)} is not an API protocol. A custom endpoint needs one.`);
    const text = JSON.stringify(raw, null, 2) + '\n';
    if (Buffer.byteLength(text) > MAX_MANIFEST) return fail(400, 'The manifest is larger than 256 KB.');
    try {
      putFolder(env.home, id, text);
    } catch {
      return fail(409, `${id$(id)} could not be added. Nothing was written.`);
    }
    if (typeof key === 'string' && key.trim()) {
      try {
        setKey(env.home, id, key);
      } catch {
        quietRm(path.join(modsDir(env.home), id));
        return fail(500, 'The key could not be saved, so the endpoint was not added.');
      }
    }
    return reloaded(env, { id });
  });
}

// ---- PUT /api/mods/:id

const EDITABLE = new Set(['label', 'description', 'homepage', 'version', 'baseUrl', 'modelsUrl', 'defaultModel', 'models', 'price', 'efforts', 'defaultEffort', 'headers', 'auth', 'body', 'reasoning', 'usage', 'switchPrice', 'cacheWritePerInput', 'untested']);
const LOCKED = new Set(['reins', 'id', 'kind', 'protocol', 'main']);

/** Changes some fields of an installed or custom provider's manifest; `null` removes a field. Checked whole before anything is written. */
export function editMod(env: ModEnv, id: unknown, b: Record<string, unknown>): Promise<Reply> {
  if (!isModId(id)) return Promise.resolve(fail(400, 'That is not a valid mod id.'));
  if ('key' in b) return Promise.resolve(fail(400, KEY_WORDS));
  for (const k of Object.keys(b)) {
    if (LOCKED.has(k)) return Promise.resolve(fail(400, `\`${k}\` cannot be changed here. Remove the provider and add it again.`));
    if (!EDITABLE.has(k)) return Promise.resolve(fail(400, `\`${cap(k, 40)}\` is not a field Reins lets you edit.`));
  }
  return serial(env.home, async () => {
    const mod = env.mods.mods.find((m) => m.id === id);
    if (!mod) return fail(404, `No mod ${id$(id)} is installed.`);
    if (mod.source === 'bundled') return fail(409, `${id$(id)} is built in and cannot be edited. Disable it, or add your own endpoint.`);
    if (mod.kind !== 'provider') return fail(409, `${id$(id)} is not a provider, so it cannot be edited here.`);
    const dir = folderOf(env.home, id);
    let current: unknown;
    try { current = dir ? JSON.parse(fs.readFileSync(path.join(dir, 'mod.json'), 'utf8')) : undefined; } catch { /* worded below */ }
    if (!isObj(current)) return fail(409, `${id$(id)} has a mod.json Reins cannot read. Fix the file, or remove the provider.`);
    const raw: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(b)) {
      if (v === null) delete raw[k];
      else raw[k] = v;
    }
    if (holdsDeep(env, raw)) return fail(400, KEY_IN_MOD);
    const problems = problemsOf(env, raw, id);
    if (problems.length) return refusal(problems);
    const text = JSON.stringify(raw, null, 2) + '\n';
    if (Buffer.byteLength(text) > MAX_MANIFEST) return fail(400, 'The manifest is larger than 256 KB.');
    try {
      writeWhole(env.home, path.join(dir!, 'mod.json'), text);
    } catch {
      return fail(409, `${id$(id)} could not be saved. The old file is unchanged.`);
    }
    return reloaded(env, { id });
  });
}

// ---- POST /api/mods/:id/enable|disable

export function setEnabled(env: ModEnv, id: unknown, on: boolean): Promise<Reply> {
  if (!isModId(id)) return Promise.resolve(fail(400, 'That is not a valid mod id.'));
  return serial(env.home, async () => {
    if (!env.mods.mods.some((m) => m.id === id)) return fail(404, `No mod ${id$(id)} is installed.`);
    const off = readDisabled(env.home);
    if (on) off.delete(id);
    else off.add(id);
    try {
      writeWhole(env.home, disabledFile(env.home), JSON.stringify([...off].sort(), null, 2) + '\n');
    } catch {
      return fail(409, 'The setting could not be saved.');
    }
    return reloaded(env, { id, enabled: on });
  });
}

// ---- DELETE /api/mods/:id

export function removeMod(env: ModEnv, id: unknown): Promise<Reply> {
  if (!isModId(id)) return Promise.resolve(fail(400, 'That is not a valid mod id.'));
  return serial(env.home, async () => {
    const mod = env.mods.mods.find((m) => m.id === id);
    if (!mod) return fail(404, `No mod ${id$(id)} is installed.`);
    if (mod.source === 'bundled') return fail(409, `${id$(id)} is built in and cannot be removed. You can disable it.`);
    const dir = path.join(modsDir(env.home), id);
    try {
      // A link is unlinked, never followed: what it points at is not ours to delete.
      if (fs.lstatSync(dir).isSymbolicLink()) { try { fs.unlinkSync(dir); } catch { fs.rmdirSync(dir); } } else fs.rmSync(dir, { recursive: true });
    } catch {
      return fail(409, `${id$(id)} could not be removed.`);
    }
    // The key (secrets file) stays: a later install of the same id finds it again. The yes answers go with the mod, so a later install asks again.
    // The on/off mark goes with the mod.
    env.consent.revoke(id);
    setTrust(env.home, id, undefined); // trust goes with the mod: the same files imported again ask again
    const off = readDisabled(env.home);
    if (off.delete(id)) writeWhole(env.home, disabledFile(env.home), JSON.stringify([...off].sort(), null, 2) + '\n');
    return reloaded(env, { id });
  });
}

// ---- POST /api/mods/:id/trust

/**
 * Trusts the code of an INSTALLED user mod. The body names the hash the user was shown (the list carries it); the folder on disk is read and
 * hashed again now, and only when it is exactly that hash is trust recorded for it. So bytes that changed since the list was read are never trusted.
 * The code runs at once (as "Trust and import" does), or after a restart when other code of this id already ran.
 */
export function trustMod(env: ModEnv, id: unknown, b: Record<string, unknown>): Promise<Reply> {
  if (!isModId(id)) return Promise.resolve(fail(400, BAD_ID));
  if (typeof b.hash !== 'string' || b.hash === '') return Promise.resolve(fail(400, '`hash` must be the hash the code prompt showed.'));
  return serial(env.home, async () => {
    const mod = env.mods.mods.find((m) => m.id === id);
    if (!mod) return fail(404, `No mod ${id$(id)} is installed.`);
    if (mod.source === 'bundled') return fail(409, `${id$(id)} is built in; there is nothing to trust.`);
    if (!mod.hasCode) return fail(409, `${id$(id)} has no code, so there is nothing to trust.`);
    let now: string;
    try {
      now = hashFiles(readFolder(path.join(modsDir(env.home), id), id));
    } catch {
      return fail(409, `${id$(id)} could not be read, so it was not trusted.`);
    }
    if (now !== b.hash) return fail(409, `${id$(id)} changed since you looked at it. Nothing was trusted; look at it again.`);
    try {
      setTrust(env.home, id, now);
    } catch {
      return fail(500, 'The trust could not be saved.');
    }
    const r = await reloaded(env, { id });
    const after = env.mods.mods.find((m) => m.id === id);
    (r.body as Record<string, unknown>).trust = after ? trustOf(env, after) : 'none';
    return r;
  });
}

// ---- POST /api/mods/:id/reinstall

export function reinstallMod(env: ModEnv, id: unknown): Promise<Reply> {
  if (!isModId(id)) return Promise.resolve(fail(400, 'That is not a valid mod id.'));
  return serial(env.home, async () => {
    const mod = env.mods.mods.find((m) => m.id === id);
    if (!mod) return fail(404, `No mod ${id$(id)} is installed.`);
    if (mod.source === 'bundled') return fail(409, `${id$(id)} is built in and has no catalog copy to install.`);
    const raw = readCatalog(env, id);
    if (!raw) return fail(404, `${id$(id)} is not in the catalog, so there is nothing to install again.`);
    const problems = problemsOf(env, raw, id);
    if (problems.length) return refusal(problems);
    const final = path.join(modsDir(env.home), id);
    const old = scratch(env.home, `old-${id}`);
    try {
      const text = fs.readFileSync(path.join(env.catalogDir, id, 'mod.json'), 'utf8');
      const had = there(final);
      if (had) fs.renameSync(final, old);
      try {
        putFolder(env.home, id, text);
      } catch (e) {
        if (had) fs.renameSync(old, final); // the old copy goes back whole
        throw e;
      }
    } catch {
      return fail(409, `${id$(id)} could not be installed again. Your copy is unchanged.`);
    }
    quietRm(old);
    env.consent.revoke(id); // a new copy of the manifest asks again; nothing is regranted for it
    return reloaded(env, { id });
  });
}

// ---- PUT / DELETE /api/mods/:id/key

const MAX_KEY = 4096;
const SHORT_KEY = `The key must be at least ${MIN_SECRET} characters. Reins can hide a longer key from logs and errors, not a shorter one.`;
const BAD_ID = 'That is not a valid mod id.';

/** The provider mod of this id (on or off) and its raw `auth`, for the key routes. The key never goes in the manifest; only the states are read. */
function keyed(env: ModEnv, id: string): { auth: { style: string; keyEnv: string[] } } | Reply {
  const mod = env.mods.mods.find((m) => m.id === id && m.kind === 'provider');
  if (!mod) return fail(404, `No provider ${id$(id)} is installed.`);
  const auth = isObj(mod.manifest) && isObj(mod.manifest.auth) ? mod.manifest.auth : undefined;
  if (!auth || (auth.style !== 'bearer' && auth.style !== 'header')) return fail(409, `${id$(id)} does not use a key.`);
  return { auth: { style: auth.style, keyEnv: Array.isArray(auth.keyEnv) ? auth.keyEnv.filter((n): n is string => typeof n === 'string') : [] } };
}
const stateOf = (env: ModEnv, id: string, a: { auth: { style: string; keyEnv: string[] } }): KeyStatus => keyStatus({ id, auth: a.auth }, readSecrets(env.home), env.env);

/** Stores the key in the secrets file (spec 8.1). The answer is the key's STATE; the value is never sent back, not even in part. */
export function putKey(env: ModEnv, id: unknown, b: Record<string, unknown>): Promise<Reply> {
  if (!isModId(id)) return Promise.resolve(fail(400, BAD_ID));
  const key = b.key;
  if (typeof key !== 'string' || key.trim() === '') return Promise.resolve(fail(400, 'The key must be text that is not empty.'));
  if (hasControl(key)) return Promise.resolve(fail(400, 'The key must have no line breaks or control characters.'));
  if (key.trim().length < MIN_SECRET) return Promise.resolve(fail(400, SHORT_KEY));
  if (key.length > MAX_KEY) return Promise.resolve(fail(400, `The key is longer than ${MAX_KEY} characters.`));
  return serial(env.home, async () => {
    const a = keyed(env, id);
    if (!('auth' in a)) return a;
    try {
      setKey(env.home, id, key);
    } catch {
      return fail(500, 'The key could not be saved.');
    }
    return { status: 200, body: { ok: true, keyStatus: stateOf(env, id, a) } };
  });
}

export function deleteKey(env: ModEnv, id: unknown): Promise<Reply> {
  if (!isModId(id)) return Promise.resolve(fail(400, BAD_ID));
  return serial(env.home, async () => {
    const a = keyed(env, id);
    try {
      clearKey(env.home, id); // also for a mod that is gone: its key stayed in the file
    } catch {
      return fail(500, 'The key could not be cleared.');
    }
    return { status: 200, body: { ok: true, keyStatus: 'auth' in a ? stateOf(env, id, a) : { state: 'missing' } } };
  });
}

// ---- POST /api/mods/:id/consent, DELETE /api/mods/:id/consent

/**
 * Spec 7.8: records the user's yes for this provider and the origin of ITS base address. The origin is read from the manifest, never taken from
 * the body; the body MUST name the origin the user was shown (the Test connection challenge returns it) and it must still be the manifest's:
 * a missing or different one is a 409 and nothing is recorded (the provider may have been edited or replaced while the dialog was open).
 * `revoke: true` forgets every origin of the id and needs no origin.
 */
export function setConsent(env: ModEnv, id: unknown, b: Record<string, unknown>): Promise<Reply> {
  if (!isModId(id)) return Promise.resolve(fail(400, BAD_ID));
  if (b.origin !== undefined && typeof b.origin !== 'string') return Promise.resolve(fail(400, '`origin` must be text.'));
  if (b.revoke !== undefined && typeof b.revoke !== 'boolean') return Promise.resolve(fail(400, '`revoke` must be true or false.'));
  return serial(env.home, async () => {
    if (b.revoke === true) {
      env.consent.revoke(id);
      return { status: 200, body: { ok: true, consent: 'needed' } };
    }
    const found = wireProvider(env.mods, id);
    if (!found) return fail(404, `No provider ${id$(id)} that Reins sends to is installed.`);
    const origin = originOf(found.manifest.baseUrl);
    if (!origin) return fail(409, `The base address of ${id$(id)} is not a web address.`);
    if (b.origin === undefined) return fail(409, `Say which address the yes is for: ${id$(id)} sends to ${origin}. Nothing was allowed.`);
    if (b.origin !== origin) return fail(409, `${id$(id)} no longer sends to the address you were shown; it sends to ${origin}. Nothing was allowed; ask again.`);
    env.consent.grant(id, origin);
    return { status: 200, body: { ok: true, consent: 'granted', origin } };
  });
}

export function revokeConsent(env: ModEnv, id: unknown): Promise<Reply> {
  return setConsent(env, id, { revoke: true });
}

// ---- POST /api/mods/:id/test

const TEST_MS = 8000;
const MAX_TEST_TEXT = 200;
const MAX_LIST_BODY = 1024 * 1024;

/**
 * Spec 7.6: one GET of the model list, through `send` (same origin, no redirect), never a model call, never retried. The answer is one of
 * `ok`, `bad-key`, `not-found`, `unreachable`, `redirected`, or `needs-consent` (no request was made). Provider text is cut to 200
 * characters and redacted; the key is in no part of the answer.
 */
export async function testConnection(env: ModEnv, id: unknown): Promise<Reply> {
  if (!isModId(id)) return fail(400, BAD_ID);
  const found = wireProvider(env.mods, id);
  if (!found) return fail(404, `No provider ${id$(id)} that Reins sends to is installed.`);
  const { manifest, protocol } = found;
  const origin = originOf(manifest.baseUrl);
  const label = cap(typeof manifest.label === 'string' && manifest.label ? manifest.label : id, 60);
  const done = (result: string, message: string, extra: Record<string, unknown> = {}): Reply =>
    ({ status: 200, body: { result, message: env.redact(message), ...extra } });
  if (!origin) return done('unreachable', `The base address of ${id$(id)} is not a web address.`);
  const host = new URL(origin).host;
  const keyNames = manifest.auth?.keyEnv ?? [];
  const needsKey = !!manifest.auth && manifest.auth.style !== 'none';
  // A provider with a key is asked about FIRST, with no request made. A keyless one sends no prompt and no key to its model list (7.8), so it is not.
  // The challenge carries the canonical origin it asked about: the dialog posts exactly that back, and a different one is refused.
  if (needsKey && !env.consent.has(id, origin)) {
    return done('needs-consent', `Reins has not been allowed to send your key to ${host} yet.`, { host, origin });
  }
  if (needsKey && keyStatus(manifest, readSecrets(env.home), env.env).state === 'missing') {
    return done('bad-key', `${label} has no key. ${keyNames.length ? `Set ${keyNames.join(' or ')}, or add` : 'Add'} a key in Settings > Providers.`, { host });
  }
  const ms = env.testTimeoutMs ?? TEST_MS;
  try {
    // The wire's own list request (address with its fixed query, headers, key-header default): the same one the live model list sends.
    const req = protocol.wire.listRequest?.(manifest) ?? { manifest, url: manifest.modelsUrl ?? `${manifest.baseUrl.replace(/\/+$/, '')}/models`, headers: { accept: 'application/json' } };
    const res = await env.send(req.manifest, req.url, { method: 'GET', headers: req.headers, signal: AbortSignal.timeout(ms) }, 'models');
    // A read that fails (timeout, abort, a stalled body) or is over the cap is an error like any other: it goes to the handler below, never to `ok`.
    const { text, over } = await readBounded(res, MAX_LIST_BODY);
    if (over) throw new Error(`The model list is larger than ${MAX_LIST_BODY / 1024 / 1024} MB.`);
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = undefined; }
    const list = Array.isArray(body) ? body : isObj(body) && Array.isArray(body.data) ? body.data : undefined;
    // Reached, but what came back is not a model list (a web page, other JSON): the closest of the five is the 404 one, said plainly.
    // Only what the live list would keep counts: a nonempty array with no valid model id in it (`[null, 42, {}]`) is no model list.
    const ids = list ? cleanIds(modelIdsFrom(list)) : [];
    if (!list || (list.length > 0 && ids.length === 0)) return done('not-found', `Reached ${host}, but it answered with something that is not a model list, so the first reply will tell.`, { host });
    return done('ok', `Reached ${host}: ${ids.length} ${ids.length === 1 ? 'model' : 'models'}.`, { host, models: ids.length });
  } catch (e) {
    if (e instanceof ProviderChanged) return done('unreachable', e.message, { host });
    const cls = e instanceof ConsentNeeded ? 'consent' : classify(e);
    if (cls === 'consent') return done('needs-consent', `Reins has not been allowed to send your key to ${host} yet.`, { host, origin });
    if (cls === 'auth') return done('bad-key', 'The key was refused.', { host });
    if (cls === 'notFound') return done('not-found', `Reached ${host}; it has no model list, so the first reply will tell.`, { host });
    if (cls === 'redirect') return done('redirected', WORDS.redirect.say(label, undefined, ''), { host });
    if (e instanceof ProviderError) return done('unreachable', `Cannot reach ${host}: it answered ${e.status}. ${env.redact(e.message.replace(/^[\s\S]*?answered \d{3}(?:: )?/, ''), MAX_TEST_TEXT)}`.trim(), { host });
    const name = (e as { name?: unknown })?.name;
    if (name === 'TimeoutError' || name === 'AbortError') return done('unreachable', `Cannot reach ${host}: no answer in ${Math.round(ms / 100) / 10} seconds.`, { host });
    return done('unreachable', `Cannot reach ${host}: ${env.redact(e instanceof Error ? e.message : String(e), MAX_TEST_TEXT)}`, { host });
  }
}

// ---- GET /api/mods/:id/export, POST /api/mods/import/preview, POST /api/mods/import (spec 7.7)

const MAX_TOTAL = 1024 * 1024;
const MAX_FILES = 50;
const MAX_NAME = 100;
const WIN_RESERVED = /^(nul|con|prn|aux|com[1-9]|lpt[1-9])$/i;
const NAME_OK = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
/** The words of the second prompt for a mod with code (spec 7.7). */
export const CODE_PROMPT = 'This mod runs its own code inside Reins, with your rights: it can read your files and your keys, and use the network. Reins cannot limit what it does. Trust it only if you trust its author.';
/** Files Reins keeps in its home; no export ever reads or holds them. */
const HOME_FILES = new Set(['secrets.json', 'disabled-mods.json', 'mod-trust.json', 'mod-cache']);

/** Why a file name cannot be part of a mod file, in plain words; undefined when it can. Flat names only, safe on every system. */
function nameProblem(name: string): string | undefined {
  const n = `\`${cap(name, 40)}\``;
  if (name === '') return 'a file has an empty name.';
  if (name.length > MAX_NAME) return `${n}: a file name is longer than ${MAX_NAME} characters.`;
  if (hasControl(name)) return `${n}: a file name must not hold a control character.`;
  if (name.includes('/') || name.includes('\\')) return `${n}: a file name must not hold / or \\; a mod is one folder with no folders in it.`;
  if (name.includes('..')) return `${n}: a file name must not hold "..".`;
  if (name.includes(':')) return `${n}: a file name must not hold ":" (no drive letters).`;
  if (/[. ]$/.test(name)) return `${n}: a file name must not end in a dot or a space.`;
  if (WIN_RESERVED.test(name.split('.')[0]!)) return `${n}: this file name is a reserved name on Windows; pick another.`;
  if (name === '__proto__' || !NAME_OK.test(name)) return `${n}: a file name may hold only letters, digits, dot, dash and underscore, and must not start with a dot.`;
  return undefined;
}

/** Text that is really binary: a control character other than tab and line breaks. */
function binaryLike(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    if (k < 0x20 && k !== 9 && k !== 10 && k !== 13) return true;
  }
  return false;
}

interface FileBytes {
  rel: string;
  bytes: Buffer;
}

/**
 * Every plain-file check of an export file, no write and no state read: the shape, the count, the size, each name, each text.
 * `input` is the file as an object or as text. The exact bytes of each file are what is hashed and written.
 */
function parseModFile(input: unknown): { files: FileBytes[] } | { problems: string[] } {
  const no = (why: string) => ({ problems: [why] });
  let v = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > MAX_TOTAL) return no('The file is larger than 1 MB.');
    try { v = JSON.parse(input); } catch { return no('The file is not valid JSON.'); }
  }
  if (!isObj(v)) return no('The file must hold one JSON object: { "reinsMod": 1, "files": { ... } }.');
  for (const k of Object.keys(v)) if (k !== 'reinsMod' && k !== 'files') return no(`\`${cap(k, 40)}\` is not a field of a mod file.`);
  if (v.reinsMod !== 1) return no(v.reinsMod === undefined ? '`reinsMod` is missing; it must be 1.' : `\`reinsMod\` is ${show(v.reinsMod)}; this Reins reads mod files with \`reinsMod\` 1.`);
  if (!isObj(v.files)) return no('`files` must be an object of file names and their text.');
  // Object.entries lists an own key named __proto__ like any other; nothing here reads a name as a property.
  const entries = Object.entries(v.files);
  if (entries.length > MAX_FILES) return no(`The file holds ${entries.length} files; the most is ${MAX_FILES}.`);
  const files: FileBytes[] = [];
  let total = 0;
  for (const [name, text] of entries) {
    const why = nameProblem(name);
    if (why) return no(why);
    if (typeof text !== 'string') return no(`\`${cap(name, 40)}\` must be text.`);
    if (text.length > MAX_TOTAL) return no('The files are larger than 1 MB together.');
    const bytes = Buffer.from(text, 'utf8');
    if (binaryLike(text) || bytes.toString('utf8') !== text) return no(`\`${cap(name, 40)}\` is not text. Only text files can be imported.`);
    total += bytes.length;
    if (total > MAX_TOTAL) return no('The files are larger than 1 MB together.');
    files.push({ rel: name, bytes });
  }
  const alias = caseAlias(files.map((f) => f.rel));
  if (alias) return no(`Two files differ only in upper and lower case: \`${cap(alias[0], 40)}\`, \`${cap(alias[1], 40)}\`.`);
  if (!files.some((f) => f.rel === 'mod.json')) return no('`mod.json` is missing from the files.');
  return { files };
}

/** 127.0.0.0/8, ::1 and localhost: where a plain http key goes nowhere past this machine. */
const isLocalHost = (hostname: string) => hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);

export interface ImportSummary {
  id: string;
  label: string;
  kind: string;
  protocol: string | null;
  /** 'your': a copy the user installed is there and is replaced. 'builtin': the mod shadows a bundled one. */
  replaces: 'your' | 'builtin' | null;
  replacesLine?: string;
  /** Where a provider's prompts go, a key Reins already holds for the id, and key variables that are set now. Lines, in reading order. */
  reach: string[];
  keys: Array<{ name: string; host: string; plainHttp: boolean; line: string }>;
  /** Header names only; the values stay in the file. */
  headers: string[];
  hasCode: boolean;
  /** The second prompt, word for word (spec 7.7). Only for a mod with code. */
  codePrompt?: string;
  /** Code mods: the hash the trust is kept under, and whether it is already trusted. */
  hash?: string;
  trusted?: boolean;
  files: Array<{ name: string; bytes: number }>;
  warnings: string[];
}

type Checked = { ok: { id: string; files: FileBytes[]; summary: ImportSummary } } | { reply: Reply };

/**
 * ALL the checks of an import, with no write. Preview and apply both call this with the file as given, so apply never
 * relies on an earlier preview. The id is checked with `isModId` before it is used as a path, then the loader's own `validateMod` runs.
 */
function checkImport(env: ModEnv, input: unknown): Checked {
  // First of all, before a name, a hash or a trust line is made from it: a key in any part of the file refuses it. The decoded envelope is looked at
  // (every name, every text, every property name), not its JSON text; a file that arrives as text is parsed here only to be looked at.
  let decoded: unknown = input;
  if (typeof input === 'string') {
    if (env.holdsSecret(input)) return { reply: fail(400, KEY_IN_MOD) };
    try { decoded = JSON.parse(input); } catch { decoded = undefined; }
  }
  if (holdsDeep(env, decoded)) return { reply: fail(400, KEY_IN_MOD) };
  const parsed = parseModFile(input);
  if ('problems' in parsed) return { reply: refusal(parsed.problems) };
  const { files } = parsed;
  const p = parseManifest(files.find((f) => f.rel === 'mod.json')!.bytes, 'mod.json');
  if ('error' in p) return { reply: refusal([p.error]) };
  const raw = p.raw;
  // The parsed manifest too (its decoded values and property names), before validation words anything about it.
  if (holdsDeep(env, raw)) return { reply: fail(400, KEY_IN_MOD) };
  if (!isModId(raw.id)) return { reply: refusal(['The id must be lowercase letters, digits and dashes, start with a letter or digit, be at most 40 long, and not be a name Windows reserves.']) };
  const id = raw.id;
  const problems = [
    ...validateMod(raw, { folder: id, source: 'user' }, id, bundledKinds(env.mods), env.mods.registry),
    ...addressProblems(raw, id),
  ];
  const main = raw.main === undefined ? undefined : canonMain(raw.main);
  if (!problems.length && raw.main !== undefined && (main === undefined || !files.some((f) => f.rel === main))) {
    problems.push(`${id$(id)}: \`main\` is ${show(raw.main)}, which is not one of the files in this mod file.`);
  }
  if (problems.length) return { reply: refusal(problems) };
  // Text the confirmation shows must read as it is: no control, line-break or direction-changing character.
  const shown: Array<[string, unknown]> = [['label', raw.label], ['protocol', raw.protocol], ['kind', raw.kind]];
  if (isObj(raw.headers)) for (const h of Object.keys(raw.headers)) shown.push(['a header name', h]);
  if (isObj(raw.auth) && Array.isArray(raw.auth.keyEnv)) for (const k of raw.auth.keyEnv) shown.push(['a key name', k]);
  for (const [field, v] of shown) {
    if (typeof v === 'string' && hasHiddenChars(v)) return { reply: refusal([`${id$(id)}: ${field} must not hold a control, line-break or direction-changing character.`]) };
  }

  const yours = there(path.join(modsDir(env.home), id));
  const builtin = env.mods.mods.some((m) => m.id === id && (m.source === 'bundled' || m.replaces === 'bundled'));
  const auth = isObj(raw.auth) ? raw.auth : undefined;
  let host = '';
  let plain = false;
  try {
    const u = new URL(String(raw.baseUrl));
    host = u.host;
    plain = u.protocol === 'http:' && !isLocalHost(u.hostname);
  } catch { /* a mod with no address sends nothing */ }
  const names = auth && auth.style !== 'none' && Array.isArray(auth.keyEnv) ? auth.keyEnv.filter((n): n is string => typeof n === 'string') : [];
  const hasCode = raw.main !== undefined;
  const sendsKey = !!auth && auth.style !== 'none';
  // Where it goes and with what: the host (also for a keyless provider: prompts and files go there), a key Reins already holds for this id
  // (the value is never read into the answer, only whether one exists), and each key variable that is set right now.
  const reach = raw.kind === 'provider' && host ? [
    `sends your prompts and files to ${host}${plain ? ' over plain http' : ''}`,
    ...(sendsKey && readSecrets(env.home).has(id) ? [`uses the key saved for ${id}`] : []),
    ...names.filter((n) => envGet(env.env, n)?.trim()).map((n) => `reads ${n}`),
  ] : [];
  const others = files.map((f) => f.rel).filter((n) => n !== 'mod.json' && n !== main).sort();
  const hash = hasCode ? hashFiles(files) : undefined;
  const summary: ImportSummary = {
    id, label: String(raw.label), kind: String(raw.kind), protocol: typeof raw.protocol === 'string' ? raw.protocol : null,
    replaces: yours ? 'your' : builtin ? 'builtin' : null,
    ...(yours || builtin ? { replacesLine: yours ? `replaces your ${id}` : `replaces the built-in ${id}` } : {}),
    reach,
    keys: names.map((name) => ({ name, host, plainHttp: plain, line: `sends the value of ${name} to ${host}${plain ? ' over plain http' : ''}` })),
    headers: isObj(raw.headers) ? Object.keys(raw.headers) : [],
    hasCode,
    ...(hasCode ? { codePrompt: CODE_PROMPT, hash: hash!, trusted: modTrusted(env.home, id, hash!) } : {}),
    files: [...files].sort((a, b) => (a.rel < b.rel ? -1 : 1)).map((f) => ({ name: f.rel, bytes: f.bytes.length })),
    warnings: [
      ...(plain && names.length ? [`${host} is not on this machine and is reached over plain http, so the key can be read on the way.`] : []),
      ...(others.length ? [hasCode ? `also holds files the manifest does not name: ${others.join(', ')}. They are part of the code you would trust.` : `also holds files a mod without code does not use: ${others.join(', ')}.`] : []),
    ],
  };
  return { ok: { id, files, summary } };
}

/** Spec 7.7: reads a mod file and says what importing it would do. Writes nothing. */
export function importPreview(env: ModEnv, file: unknown): Reply {
  const got = checkImport(env, file);
  return 'reply' in got ? got.reply : { status: 200, body: { ok: true, summary: got.ok.summary } };
}

/**
 * The one way a mod file's bytes reach the disk. `name` has passed `nameProblem`; this still checks, by `path.relative`, that the
 * path stays inside `root` as exactly one component, that `root` is no link, and (by `wx`) that nothing is there to follow or overwrite.
 * Known limit, accepted: the checks and the write are separate calls, so a second process that can write in the Reins home could swap the
 * staging folder for a link in between (and could equally rewrite mod-trust.json, which is the bigger power). No directory handle is pinned.
 */
function writeInside(root: string, name: string, bytes: Buffer) {
  const file = path.join(root, name);
  const rel = path.relative(root, file);
  if (rel !== name || rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('outside the mod folder');
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('a link');
  fs.writeFileSync(file, bytes, { flag: 'wx' });
}

/** The staged folder holds exactly these files, with exactly these bytes: what is hashed and trusted is what is on disk. */
function stagedMatches(stage: string, files: FileBytes[]): boolean {
  const names = fs.readdirSync(stage).sort();
  if (names.join('\0') !== files.map((f) => f.rel).sort().join('\0')) return false;
  return files.every((f) => {
    const file = path.join(stage, f.rel);
    return fs.lstatSync(file).isFile() && fs.readFileSync(file).equals(f.bytes);
  });
}

/**
 * Spec 7.7: installs a mod file. Every check of the preview runs again on `b.file`. The files are built whole in a scratch folder in the
 * home and renamed in; an old copy is moved aside and put back when anything fails. A code mod runs only when `b.trust` is true (its hash is
 * recorded) or the same bytes were trusted before; a mod that shadows a built-in one needs `b.replaceBuiltin` true.
 */
export function importApply(env: ModEnv, b: Record<string, unknown>): Promise<Reply> {
  for (const k of ['trust', 'replaceBuiltin'] as const) if (b[k] !== undefined && typeof b[k] !== 'boolean') return Promise.resolve(fail(400, `\`${k}\` must be true or false.`));
  return serial(env.home, async () => {
    const got = checkImport(env, b.file);
    if ('reply' in got) return got.reply;
    const { id, files, summary } = got.ok;
    if (summary.replaces === 'builtin' && b.replaceBuiltin !== true) return fail(409, `This ${summary.replacesLine}. Import it again with replaceBuiltin true to go on.`);
    const home = env.home;
    const final = path.join(modsDir(home), id);
    let had = false;
    try {
      const st = fs.lstatSync(final);
      if (st.isSymbolicLink() || !st.isDirectory()) return fail(409, `${id$(id)} is a link or a file in the mods folder, so it was not replaced. Remove it first.`);
      had = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') return fail(409, `${id$(id)} could not be checked. Nothing was changed.`);
    }
    const stage = scratch(home, 'new');
    const old = scratch(home, `old-${id}`); // the id is in the name so a start after a crash can put the old install back (sweepScratch)
    const before = readTrust(home).get(id);
    const marked = readDisabled(home);
    let moved = false;
    let placed = false;
    let trustSet = false;
    let markCleared = false;
    let phase: 'build' | 'finish' = 'build';
    // Order: build and check the new folder, move the old one aside, move the new one in, and only THEN the trust line and the other
    // state. A crash before the trust line leaves the new code untrusted ("needs trust"), never trusted-but-missing. The backup is
    // deleted last, so any failure up to then puts everything back.
    try {
      fs.mkdirSync(stage);
      for (const f of files) writeInside(stage, f.rel, f.bytes);
      if (!stagedMatches(stage, files)) throw new Error('the staged files differ');
      fs.mkdirSync(modsDir(home), { recursive: true });
      if (had) { fs.renameSync(final, old); moved = true; }
      fs.renameSync(stage, final);
      placed = true;
      phase = 'finish';
      if (summary.hasCode && b.trust === true) { setTrust(home, id, summary.hash); trustSet = true; }
      if (!had && marked.has(id)) {
        const off = new Set(marked);
        off.delete(id);
        writeWhole(home, disabledFile(home), JSON.stringify([...off].sort(), null, 2) + '\n');
        markCleared = true;
      }
      env.consent.revoke(id); // a new manifest asks again, as Re-install does
    } catch {
      const stuck: string[] = [];
      if (placed) {
        try { fs.renameSync(final, stage); placed = false; } catch { stuck.push('the new copy is still in the mods folder'); }
      }
      if (!placed) {
        const gone = removeReport(stage);
        if (gone) stuck.push(gone);
      }
      if (moved && !placed) {
        try { fs.renameSync(old, final); } catch { stuck.push(`your old copy is in ${path.basename(old)} in the Reins folder`); }
      }
      if (trustSet) {
        try { setTrust(home, id, before); } catch { stuck.push('the trust line could not be put back'); }
      }
      if (markCleared) {
        try { writeWhole(home, disabledFile(home), JSON.stringify([...marked].sort(), null, 2) + '\n'); } catch { stuck.push('the on/off mark could not be put back'); }
      }
      const base = `${id$(id)} could not be imported`;
      return { status: phase === 'build' ? 409 : 500, body: { error: stuck.length ? `${base} and could not be fully undone: ${stuck.join('; ')}.` : `${base}. Nothing was changed.` } };
    }
    const left: string[] = [];
    if (moved) {
      const gone = removeReport(old);
      if (gone) left.push(gone);
    }
    const r = await reloaded(env, { id, replaced: had });
    const body = r.body as Record<string, unknown>;
    if (left.length) body.problems = [...(Array.isArray(body.problems) ? body.problems : []), ...left];
    const now = env.mods.mods.find((m) => m.id === id);
    body.trust = now ? trustOf(env, now) : 'none';
    return r;
  });
}

/** At most `budget` bytes of a plain file, read through one open descriptor, however big it is or grows. */
function readBudget(file: string, budget: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('not a file');
    const buf = Buffer.alloc(budget);
    let n = 0;
    while (n < budget) {
      const r = fs.readSync(fd, buf, n, budget - n, null);
      if (r === 0) break;
      n += r;
    }
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** Spec 7.7: the mod's own files as `{ reinsMod: 1, files }`. No secret: only the mod folder is read, and a file holding a known key is refused. */
export function exportMod(env: ModEnv, id: unknown): Reply {
  if (!isModId(id)) return fail(400, BAD_ID);
  // The id is the download's file name, and a header is not redacted: an id that is a known key is never sent. Generic words, no value.
  if (env.holdsSecret(id)) return fail(409, 'This mod cannot be exported.');
  const mod = env.mods.mods.find((m) => m.id === id);
  if (!mod) return fail(404, `No mod ${id$(id)} is installed.`);
  const no = (why: string) => fail(409, `${id$(id)} was not exported: ${why}`);
  const files: Record<string, string> = {};
  try {
    if (fs.lstatSync(mod.dir).isSymbolicLink()) return no('its folder is a link.');
    const entries = fs.readdirSync(mod.dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    if (entries.length > MAX_FILES) return no(`it holds ${entries.length} files; the most is ${MAX_FILES}.`);
    let total = 0;
    for (const d of entries) {
      if (env.holdsSecret(d.name)) return no('a file name holds a key Reins knows. Rename the file.'); // before any message that would print the name
      const why = nameProblem(d.name);
      if (why) return no(why);
      if (HOME_FILES.has(d.name)) return no(`\`${d.name}\` belongs to Reins, not to a mod.`);
      const file = path.join(mod.dir, d.name);
      const st = fs.lstatSync(file);
      if (st.isSymbolicLink()) return no(`\`${cap(d.name, 40)}\` is a link.`);
      if (!st.isFile()) return no(`\`${cap(d.name, 40)}\` is a folder; a mod file holds no folders.`);
      // The size from lstat is not trusted (a file can grow): at most the room left plus one byte is read, and the bytes read are what count.
      const bytes = readBudget(file, MAX_TOTAL - total + 1);
      total += bytes.length;
      if (total > MAX_TOTAL) return no('its files are larger than 1 MB together.');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return no(`\`${cap(d.name, 40)}\` is not text. Only text files can be exported.`); }
      if (binaryLike(text) || !Buffer.from(text, 'utf8').equals(bytes)) return no(`\`${cap(d.name, 40)}\` is not text. Only text files can be exported.`);
      if (env.holdsSecret(text)) return no(`\`${cap(d.name, 40)}\` holds a key Reins knows. Take the key out of the file; keys go in Settings > Providers, never in a mod.`);
      files[d.name] = text;
    }
  } catch {
    return no('its files could not be read.');
  }
  return { status: 200, body: { reinsMod: 1, files }, headers: { 'content-disposition': `attachment; filename="${id}.reins-mod.json"` } };
}
