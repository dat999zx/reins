// The settings actions for provider mods (spec 7.3 to 7.5): list, install, custom, edit, enable, disable, remove, re-install.
// Plain functions over a Reins home and the loaded mods; the server only routes to them. Every manifest is checked with the loader's own
// `validateMod` before a byte is written, a file is written whole (temp file, then rename), and the loader is asked to read again after.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CARDS, CONDS, NODES, condAtoms, hasHiddenChars, parseWorkflow, type Step } from '@reins/core';
import { MIN_SECRET, clearKey, envGet, keyStatus, readSecrets, secretsFile, setKey, type KeyStatus } from '../secrets.js';
import { ConsentNeeded, ProviderChanged, ProviderError } from '../send.js';
import { readBounded } from '../loop/bounded.js';
import { classify, WORDS } from '../loop/retry.js';
import { modelIdsFrom } from '../loop/wire-util.js';
import { cleanIds } from '../live-models.js';
import { cap, show } from './kinds.js';
import { canonMain, caseAlias, hashFiles, isModId, parseManifest, readFolder, REQUIRED_TAIL, validateMod } from './loader.js';
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

/** The built-ins by id: a bundled mod, or the copy that stands in its place. */
const builtIns = (mods: Mods) => mods.mods.filter((m) => m.source === 'bundled' || m.replaces === 'bundled');
const bundledKinds = (mods: Mods) => new Map(builtIns(mods).map((m): [string, string] => [m.id, m.kind]));
const bundledViews = (mods: Mods) => new Map(builtIns(mods).map((m): [string, unknown] => [m.id, m.replaces ? m.builtinView : (m.manifest as { view?: unknown } | undefined)?.view]));
/** What is wrong with a provider manifest that would be saved as `<mods>/<id>`, in plain words: the loader's checks plus the rules for data. */
function problemsOf(env: ModEnv, raw: Record<string, unknown>, id: string): string[] {
  const out = validateMod(raw, { folder: id, source: 'user' }, id, bundledKinds(env.mods), env.mods.registry, bundledViews(env.mods));
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
/** The mod of this id that a change is meant for: the user's own copy when there is one (a built-in of the same id may be listed beside a copy that failed). */
const entry = (env: ModEnv, id: string) => env.mods.mods.find((m) => m.id === id && m.source === 'user') ?? env.mods.mods.find((m) => m.id === id);

/** Whether version `a` is newer than `b`: dotted numbers (1 to 4 of them), compared left to right. Anything else is never "newer". */
export function isNewer(a: unknown, b: unknown): boolean {
  const parts = (v: unknown) => (typeof v === 'string' && /^\d{1,9}(\.\d{1,9}){0,3}$/.test(v) ? v.split('.').map(Number) : undefined);
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

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

/** The loader's line for a carried block, condition or card mod that was changed, switched off, un-trusted or removed (`loader.ts`). */
const isNotice = (p: string) => p.endsWith(': applies after a restart.') || p.includes(REQUIRED_TAIL);

// What a block, condition or card mod brings, read from its manifest alone (nothing of its code has run). `key` is the `provides` list, `core` is where
// Reins keeps that thing. A new mod kind that brings something to core is one more row here.
const BRINGS = [
  { key: 'kinds', noun: 'block', core: NODES },
  { key: 'conditions', noun: 'condition', core: CONDS },
  { key: 'cards', noun: 'card', core: CARDS },
] as const;
const ALSO = [['ops', 'its operations'], ['events', 'may log the events'], ['attrs', 'may use the attributes']] as const;
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
/** The names a `provides` list holds. A manifest that was not checked yet may hold anything: only plain names are kept. */
const namesOf = (p: unknown, key: string): string[] => {
  const v = isObj(p) ? p[key] : undefined;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && NAME.test(x)).slice(0, 50) : [];
};
const clean = (v: unknown): v is string => typeof v === 'string' && v !== '' && !hasHiddenChars(v);

/** The lines of "what it adds": the block, condition or card names, then its operations, events and attributes, then its entry in the block list. Empty for any other mod. */
function addsOf(raw: Record<string, unknown>): string[] {
  const out = BRINGS.flatMap((b) => namesOf(raw.provides, b.key).map((n) => `adds the ${b.noun} \`${n}\``));
  if (!out.length) return [];
  for (const [key, words] of ALSO) {
    const names = namesOf(raw.provides, key);
    if (names.length) out.push(`${words}: ${names.join(', ')}`);
  }
  const card = isObj(raw.view) && isObj(raw.view.card) ? raw.view.card : undefined;
  if (clean(card?.label)) out.push(`shown in the block list as ${show(card.label)}${clean(card.section) ? ` under ${show(card.section)}` : ''}`);
  // A block with no code (a data block) says so: there is nothing to run, so nothing to trust.
  if (raw.kind === 'block' && raw.main === undefined) {
    out.push('has no code, so there is nothing to trust');
    // The prompt it sends, cut. Not yet checked (this is the preview): a hidden character is named, never passed on.
    const turn = raw.turn;
    if (typeof turn === 'string') out.push(hasHiddenChars(turn.replaceAll('\n', '')) ? 'its prompt holds a hidden character, so the mod will be refused' : `its prompt is ${cap(JSON.stringify(turn), 300)}`);
  }
  return out;
}

/** What a mod file brings that Reins already has: its code would be refused at start. A mod's own earlier copy is not a clash. */
function clashes(env: ModEnv, raw: Record<string, unknown>, id: string): string[] {
  const before = env.mods.mods.find((m) => m.id === id)?.manifest;
  const had = isObj(before) ? before.provides : undefined;
  return BRINGS.flatMap((b) => namesOf(raw.provides, b.key)
    .filter((n) => b.core.has(n) && !namesOf(had, b.key).includes(n))
    .map((n) => `the ${b.noun} \`${n}\` already exists in Reins, so the code of this mod would be refused.`));
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
    // The default pack: its mods can be customized (copied to the user's folder), and a required one has no off switch.
    ...(m.pack ? { pack: m.pack } : {}),
    ...(m.required ? { required: true } : {}),
    // A copy of a built-in says which version the built-in is, and when the built-in has gone ahead of it.
    ...(m.replaces && m.builtinVersion ? { builtinVersion: m.builtinVersion, ...(isNewer(m.builtinVersion, man.version) ? { newer: true } : {}) } : {}),
    // The loader's "applies after a restart" line is news, not a fault: it is told apart so the list does not draw it as an error.
    problems: trust === 'restart' ? [`${id$(m.id)}: ${RESTART}.`] : m.problems.filter((p) => !isNotice(p)),
    ...(m.problems.some(isNotice) ? { notices: m.problems.filter(isNotice) } : {}),
    // What a block, condition or card mod adds, from its manifest (the words the import preview used).
    ...(addsOf(man).length ? { adds: addsOf(man) } : {}),
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
  // The pack line of the first-run screen: the mods of the default pack, and which of them cannot be switched off.
  const pack = env.mods.mods.filter((m) => m.pack).map((m) => ({ id: m.id, label: typeof (m.manifest as { label?: unknown } | undefined)?.label === 'string' ? (m.manifest as { label: string }).label : m.id, enabled: m.enabled, required: m.required === true }));
  return { status: 200, body: { mods: env.mods.mods.map((m) => summary(env, m)), firstRun, chooser: await chooser(env, firstRun), pack, problems: env.mods.problems, secretsPath: secretsFile(env.home) } };
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
    const mod = entry(env, id);
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
    const mod = entry(env, id);
    if (!mod) return fail(404, `No mod ${id$(id)} is installed.`);
    if (!on && mod.required) return fail(409, `${id$(id)} is required: Reins cannot run without it, so it cannot be switched off. You can customize it instead.`);
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
    const mod = entry(env, id);
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
    const mod = entry(env, id);
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
    const after = entry(env, id);
    (r.body as Record<string, unknown>).trust = after ? trustOf(env, after) : 'none';
    return r;
  });
}

// ---- POST /api/mods/:id/reinstall

export function reinstallMod(env: ModEnv, id: unknown): Promise<Reply> {
  if (!isModId(id)) return Promise.resolve(fail(400, 'That is not a valid mod id.'));
  return serial(env.home, async () => {
    const mod = entry(env, id);
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
/** One more line under the code prompt for a block whose ops may start tracks (spec 9: `starts`, `share`, `usd`). */
export const TRACKS_LINE = 'This mod may run several sessions at once and spend money on them.';
/**
 * Whether a block mod says its ops start tracks (`tracks: true` in the manifest), or its code text calls `tracks.start`. The code is read as text, never run.
 * ponytail: a mod that hides the call (a computed name) and leaves the manifest silent gets no line; the fence at run time is what stops it, not this.
 */
const startsTracks = (raw: Record<string, unknown>, files: FileBytes[]) => raw.kind === 'block' && raw.main !== undefined
  && (raw.tracks === true || files.some((f) => /\.[cm]?js$/.test(f.rel) && /\btracks\s*\.\s*start\b/.test(f.bytes.toString('utf8'))));
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
  /** A block, condition or card mod: what it adds, from its manifest, shown before any of its code runs. Empty for any other mod. */
  adds: string[];
  hasCode: boolean;
  /** The second prompt, word for word (spec 7.7). Only for a mod with code. */
  codePrompt?: string;
  /** A block whose ops may start tracks: one more line for the code prompt (`TRACKS_LINE`). */
  tracksLine?: string;
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
    ...validateMod(raw, { folder: id, source: 'user' }, id, bundledKinds(env.mods), env.mods.registry, bundledViews(env.mods)),
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
    adds: addsOf(raw),
    hasCode,
    ...(hasCode ? { codePrompt: CODE_PROMPT, hash: hash!, trusted: modTrusted(env.home, id, hash!) } : {}),
    ...(startsTracks(raw, files) ? { tracksLine: TRACKS_LINE } : {}),
    files: [...files].sort((a, b) => (a.rel < b.rel ? -1 : 1)).map((f) => ({ name: f.rel, bytes: f.bytes.length })),
    warnings: [
      ...clashes(env, raw, id),
      ...(plain && names.length ? [`${host} is not on this machine and is reached over plain http, so the key can be read on the way.`] : []),
      ...(others.length ? [hasCode ? `also holds files the manifest does not name: ${others.join(', ')}. They are part of the code you would trust.` : `also holds files a mod without code does not use: ${others.join(', ')}.`] : []),
    ],
  };
  return { ok: { id, files, summary } };
}

/** Spec 7.7: reads a mod file (or a `reinsMods` envelope) and says what importing it would do. Writes nothing. */
export function importPreview(env: ModEnv, file: unknown): Reply {
  if (isEnvelope(file)) return previewEnvelope(env, file);
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

/** One mod placed in the home. `undo` takes all of it back (folder, old copy, trust line, on/off mark) and `commit` makes it final; both return lines for what could not be done. */
interface Placed {
  had: boolean;
  undo(): string[];
  commit(): string[];
}

/**
 * Puts one checked mod in the mods folder: the steps and their order of an import. Nothing is final until `commit`, and `undo` works until then, so an
 * envelope of several mods takes every placed mod back when a later one fails. A failure inside is undone here and comes back as the reply.
 */
function placeMod(env: ModEnv, got: { id: string; files: FileBytes[]; summary: ImportSummary }, trust: boolean): { placed: Placed } | { reply: Reply } {
  const { id, files, summary } = got;
  const home = env.home;
  const final = path.join(modsDir(home), id);
  let had = false;
  try {
    const st = fs.lstatSync(final);
    if (st.isSymbolicLink() || !st.isDirectory()) return { reply: fail(409, `${id$(id)} is a link or a file in the mods folder, so it was not replaced. Remove it first.`) };
    had = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') return { reply: fail(409, `${id$(id)} could not be checked. Nothing was changed.`) };
  }
  const stage = scratch(home, 'new');
  const old = scratch(home, `old-${id}`); // the id is in the name so a start after a crash can put the old install back (sweepScratch)
  const before = readTrust(home).get(id);
  const trustFileWas = there(trustFile(home));
  const marked = readDisabled(home);
  let moved = false;
  let placed = false;
  let trustSet = false;
  let markCleared = false;
  let phase: 'build' | 'finish' = 'build';
  const undo = (): string[] => {
    const stuck: string[] = [];
    if (placed) {
      try { fs.renameSync(final, stage); placed = false; } catch { stuck.push('the new copy is still in the mods folder'); }
    }
    if (!placed) {
      const gone = removeReport(stage);
      if (gone) stuck.push(gone);
    }
    if (moved && !placed) {
      try { fs.renameSync(old, final); moved = false; } catch { stuck.push(`your old copy is in ${path.basename(old)} in the Reins folder`); }
    }
    if (trustSet) {
      try {
        setTrust(home, id, before);
        trustSet = false;
        if (!trustFileWas && readTrust(home).size === 0) fs.rmSync(trustFile(home), { force: true }); // no trust file before, none now
      } catch { stuck.push('the trust line could not be put back'); }
    }
    if (markCleared) {
      try { writeWhole(home, disabledFile(home), JSON.stringify([...marked].sort(), null, 2) + '\n'); markCleared = false; } catch { stuck.push('the on/off mark could not be put back'); }
    }
    return stuck;
  };
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
    if (summary.hasCode && trust) { setTrust(home, id, summary.hash); trustSet = true; }
    if (!had && marked.has(id)) {
      const off = new Set(marked);
      off.delete(id);
      writeWhole(home, disabledFile(home), JSON.stringify([...off].sort(), null, 2) + '\n');
      markCleared = true;
    }
    env.consent.revoke(id); // a new manifest asks again, as Re-install does
  } catch {
    const stuck = undo();
    const base = `${id$(id)} could not be imported`;
    return { reply: { status: phase === 'build' ? 409 : 500, body: { error: stuck.length ? `${base} and could not be fully undone: ${stuck.join('; ')}.` : `${base}. Nothing was changed.` } } };
  }
  return { placed: { had, undo, commit: () => { const gone = moved ? removeReport(old) : undefined; return gone ? [gone] : []; } } };
}

/**
 * Spec 7.7: installs a mod file. Every check of the preview runs again on `b.file`. The files are built whole in a scratch folder in the
 * home and renamed in; an old copy is moved aside and put back when anything fails. A code mod runs only when `b.trust` is true (its hash is
 * recorded) or the same bytes were trusted before; a mod that shadows a built-in one needs `b.replaceBuiltin` true. A `reinsMods` envelope goes to `applyEnvelope`.
 */
export function importApply(env: ModEnv, b: Record<string, unknown>): Promise<Reply> {
  if (isEnvelope(b.file)) return applyEnvelope(env, b);
  for (const k of ['trust', 'replaceBuiltin', 'newOnly'] as const) if (b[k] !== undefined && typeof b[k] !== 'boolean') return Promise.resolve(fail(400, `\`${k}\` must be true or false.`));
  return serial(env.home, async () => {
    const got = checkImport(env, b.file);
    if ('reply' in got) return got.reply;
    const { id, summary } = got.ok;
    // Customize: the check "there is no copy of yours" is made here, inside the same turn as the write, so a copy made in between is never replaced.
    if (b.newOnly === true && summary.replaces === 'your') return fail(409, OWN_COPY(id));
    if (summary.replaces === 'builtin' && b.replaceBuiltin !== true) return fail(409, `This ${summary.replacesLine}. Import it again with replaceBuiltin true to go on.`);
    const done = placeMod(env, got.ok, b.trust === true);
    if ('reply' in done) return done.reply;
    const left = done.placed.commit();
    const r = await reloaded(env, { id, replaced: done.placed.had });
    const body = r.body as Record<string, unknown>;
    if (left.length) body.problems = [...(Array.isArray(body.problems) ? body.problems : []), ...left];
    const now = entry(env, id);
    body.trust = now ? trustOf(env, now) : 'none';
    return r;
  });
}

// ---- GET / POST /api/mods/:id/customize

const OWN_COPY = (id: string) => `You already have your own copy of ${id$(id)}. Edit it, or remove it first.`;

/**
 * The mod file Customize imports: the built-in pack mod's own files (read and checked as an export is), without `pack` and `required`, which only a
 * built-in mod may say. Everything else is the import path's: names, sizes, keys, the manifest check, the code prompt, the built-in confirm.
 */
function customizeSource(env: ModEnv, id: unknown): { file: { reinsMod: 1; files: Record<string, string> } } | { reply: Reply } {
  if (!isModId(id)) return { reply: fail(400, BAD_ID) };
  const same = env.mods.mods.filter((m) => m.id === id);
  if (!same.length) return { reply: fail(404, `No mod ${id$(id)} is installed.`) };
  if (same.some((m) => m.source === 'user') || there(path.join(modsDir(env.home), id))) return { reply: fail(409, OWN_COPY(id)) };
  if (!same.some((m) => m.source === 'bundled' && m.pack)) return { reply: fail(409, `${id$(id)} is not part of the default pack, so it cannot be customized.`) };
  // The files as they are, whole and as text. Nothing else is judged here: names, count, size, keys, binary and the manifest are the import's checks.
  const files: Record<string, string> = {};
  try {
    for (const f of readFolder(same.find((m) => m.source === 'bundled')!.dir, id)) {
      files[f.rel] = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(f.bytes);
    }
  } catch {
    return { reply: fail(409, `${id$(id)} could not be copied: its files could not be read as text.`) };
  }
  const p = parseManifest(Buffer.from(files['mod.json'] ?? '', 'utf8'), 'mod.json');
  if ('error' in p) return { reply: fail(409, `${id$(id)} could not be copied: ${p.error}`) };
  delete p.raw.pack;
  delete p.raw.required;
  return { file: { reinsMod: 1, files: { ...files, 'mod.json': JSON.stringify(p.raw, null, 2) + '\n' } } };
}

/** The file Customize would import, for the import dialog to preview. Writes nothing. */
export function customizeFile(env: ModEnv, id: unknown): Reply {
  const got = customizeSource(env, id);
  return 'reply' in got ? got.reply : { status: 200, body: { file: got.file } };
}

/**
 * Customize: copies the pack mod `id` into the user's mods folder, through the import path (`importApply`). The copy takes the built-in's place after a
 * restart. Code asks for trust as any import does (`b.trust`); a copy of yours that is already there is never replaced.
 */
export function customizeMod(env: ModEnv, id: unknown, b: Record<string, unknown>): Promise<Reply> {
  for (const k of Object.keys(b)) if (k !== 'trust') return Promise.resolve(fail(400, `\`${cap(k, 40)}\` is not a field of a customize request.`));
  const got = customizeSource(env, id);
  if ('reply' in got) return Promise.resolve(got.reply);
  return importApply(env, { file: got.file, replaceBuiltin: true, newOnly: true, ...(b.trust !== undefined ? { trust: b.trust } : {}) });
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
  const mod = entry(env, id);
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

// ---- the shareable envelope: { reinsMods: 1, mods: { <id>: files }, workflow?: { name, text } } (M3 Task 14)
// One file with a workflow and the mods it needs. Every mod goes through the single-mod checks (`checkImport`), the whole file is checked before a byte is
// written, one trust choice is made per code mod (by the hash that was shown), and the install is all or nothing.

const MAX_MODS = 20;
const MAX_WORKFLOW = 256 * 1024;
const WORKFLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;
const workflowFile = (home: string, name: string) => path.join(home, 'workflows', `${name}.reins.md`);
const noReply = (why: string) => ({ reply: refusal([why]) });

/** Whether a file (an object, or the text of one) is an envelope: it has a top-level `reinsMods`. Only a file no bigger than an import is parsed to find out. */
function isEnvelope(input: unknown): boolean {
  let v = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > MAX_TOTAL || !input.includes('"reinsMods"')) return false;
    try { v = JSON.parse(input); } catch { return false; }
  }
  return isObj(v) && Object.hasOwn(v, 'reinsMods');
}

/** A workflow of an envelope: a name (never a path) and its text. Returns the words when it cannot be taken. */
function workflowOf(env: ModEnv, w: unknown): { name: string; text: string } | string {
  if (!isObj(w)) return '`workflow` must be { "name": ..., "text": ... }.';
  for (const k of Object.keys(w)) if (k !== 'name' && k !== 'text') return `\`${cap(k, 40)}\` is not a field of the playbook; it holds a name and a text, never a path.`;
  const { name, text } = w;
  if (typeof name !== 'string' || !WORKFLOW_NAME.test(name) || WIN_RESERVED.test(name)) return 'The playbook name may hold only letters, digits, dash and underscore (at most 60), must start with a letter or digit, and is a name, never a path.';
  if (typeof text !== 'string' || text === '') return 'The playbook text must be text that is not empty.';
  if (Buffer.byteLength(text) > MAX_WORKFLOW) return `The playbook text is larger than ${MAX_WORKFLOW / 1024} KB.`;
  if (hasHiddenChars(text.replace(/[\n\r\t]/g, ''))) return 'The playbook text holds a hidden character (a control, zero-width or direction-changing one), so it was refused.';
  if (env.holdsSecret(text)) return KEY_IN_MOD;
  return { name, text };
}

interface Opened {
  mods: Array<{ id: string; files: FileBytes[]; summary: ImportSummary }>;
  workflow?: { name: string; text: string };
  /** Block, condition and card name (with its noun) to the id of the mod of this file that brings it. */
  brings: Map<string, string>;
}

/** ALL the checks of an envelope, with no write. Preview and apply both call this with the file as given. */
function openEnvelope(env: ModEnv, input: unknown): Opened | { reply: Reply } {
  let v = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > MAX_TOTAL) return noReply('The file is larger than 1 MB.');
    try { v = JSON.parse(input); } catch { return noReply('The file is not valid JSON.'); }
  }
  if (!isObj(v)) return noReply('The file must hold one JSON object: { "reinsMods": 1, "mods": { ... } }.');
  for (const k of Object.keys(v)) if (k !== 'reinsMods' && k !== 'mods' && k !== 'workflow') return noReply(`\`${cap(k, 40)}\` is not a field of a mods file.`);
  if (v.reinsMods !== 1) return noReply(`\`reinsMods\` is ${show(v.reinsMods)}; this Reins reads mods files with \`reinsMods\` 1.`);
  if (v.mods !== undefined && !isObj(v.mods)) return noReply('`mods` must be an object of mod ids and their files.');
  const entries = Object.entries(v.mods ?? {});
  if (entries.length > MAX_MODS) return noReply(`The file holds ${entries.length} mods; the most is ${MAX_MODS}.`);
  if (!entries.length && v.workflow === undefined) return noReply('The file holds no mods and no playbook.');
  // The whole file: the text of every mod file and the workflow together. (A mod with too many files is refused below, by its own check.)
  let total = isObj(v.workflow) && typeof v.workflow.text === 'string' ? Buffer.byteLength(v.workflow.text) : 0;
  for (const [, files] of entries) {
    if (isObj(files) && Object.keys(files).length <= MAX_FILES) for (const t of Object.values(files)) if (typeof t === 'string') total += Buffer.byteLength(t);
  }
  if (total > MAX_TOTAL) return noReply('The mods and the playbook are larger than 1 MB together.');
  if (holdsDeep(env, v)) return { reply: fail(400, KEY_IN_MOD) };
  const mods: Opened['mods'] = [];
  const brings = new Map<string, string>();
  for (const [key, files] of entries) {
    if (!isModId(key)) return noReply('A mod id in the file must be lowercase letters, digits and dashes, start with a letter or digit, be at most 40 long, and not be a name Windows reserves.');
    const got = checkImport(env, { reinsMod: 1, files });
    if ('reply' in got) {
      const body = got.reply.body as { error?: string; problems?: string[] };
      return { reply: { status: got.reply.status, body: { error: `The mod ${id$(key)} was refused, so nothing was installed.`, problems: (body.problems ?? [String(body.error)]).map((p) => `mod ${id$(key)}: ${p}`) } } };
    }
    if (got.ok.id !== key) return noReply(`The file lists a mod as ${id$(key)}, but its mod.json says ${id$(got.ok.id)}.`);
    let raw: unknown;
    try { raw = JSON.parse(got.ok.files.find((f) => f.rel === 'mod.json')!.bytes.toString('utf8')); } catch { raw = undefined; }
    for (const b of BRINGS) {
      for (const n of namesOf(isObj(raw) ? raw.provides : undefined, b.key)) {
        const other = brings.get(`${b.noun} ${n}`);
        if (other) return noReply(`Two mods in the file bring the ${b.noun} \`${n}\`: ${id$(other)} and ${id$(key)}.`);
        brings.set(`${b.noun} ${n}`, key);
      }
    }
    if (got.ok.summary.replaces === 'builtin') {
      got.ok.summary.warnings.push(`${id$(key)} is part of what ships with Reins. The copy in this file takes its place after a restart. Import it only if you made it or trust who did.`);
    }
    mods.push(got.ok);
  }
  if (v.workflow === undefined) return { mods, brings };
  const w = workflowOf(env, v.workflow);
  return typeof w === 'string' ? noReply(w) : { mods, workflow: w, brings };
}

/** The "Unknown step kind" lines of a workflow text; when a mod of the envelope brings the kind, the line says which. */
function unknownKinds(text: string, brings: Map<string, string>): string[] {
  const out = new Set<string>();
  for (const d of parseWorkflow(text).diagnostics) {
    const m = /^Unknown step kind "([^"]*)"/.exec(d.message);
    if (m) out.add(cap(brings.has(`block ${m[1]}`) ? `Unknown step kind "${m[1]}": the mod ${brings.get(`block ${m[1]}`)} brings it` : d.message, 200));
  }
  return [...out];
}

/** The preview of an envelope: one summary of every mod (its `adds` and its code prompt), and what the workflow would do. Writes nothing. */
function previewEnvelope(env: ModEnv, file: unknown): Reply {
  const o = openEnvelope(env, file);
  if ('reply' in o) return o.reply;
  const workflow = o.workflow && { name: o.workflow.name, exists: there(workflowFile(env.home, o.workflow.name)), diagnostics: unknownKinds(o.workflow.text, o.brings) };
  const summary = {
    envelope: true,
    mods: o.mods.map((m) => m.summary),
    adds: o.mods.flatMap((m) => m.summary.adds.map((a) => `${m.id}: ${a}`)),
    ...(workflow ? { workflow } : {}),
    warnings: workflow?.exists ? [`A playbook named ${workflow.name} is already saved, so this file cannot be imported until it is renamed or removed.`] : [],
  };
  return { status: 200, body: { ok: true, summary } };
}

/** Writes the workflow into the user's workflows folder (a new file only). Returns how to take it back, or the words. */
function saveWorkflow(home: string, w: { name: string; text: string }): { undo(): void } | string {
  const dir = path.join(home, 'workflows');
  const file = workflowFile(home, w.name);
  let made = false;
  try {
    try {
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) return 'The playbooks folder is a link or a file, so the playbook was not saved.';
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
      fs.mkdirSync(dir, { recursive: true });
      made = true;
    }
    fs.writeFileSync(file, w.text, { flag: 'wx' });
  } catch (e) {
    if (made) { try { fs.rmdirSync(dir); } catch { /* not empty or gone */ } }
    return (e as NodeJS.ErrnoException)?.code === 'EEXIST' ? `A playbook named ${w.name} is already saved.` : 'The playbook could not be saved.';
  }
  return { undo: () => { quietRm(file); if (made) { try { fs.rmdirSync(dir); } catch { /* not empty */ } } } };
}

/**
 * Imports an envelope. `b.trust` is { <mod id>: <hash the preview showed> }: a code mod is trusted only when its id is named with its hash now (a
 * changed mod asks again, and `true` trusts nothing). `b.replaceBuiltin` lists the ids that may take a built-in's place. Everything is checked first;
 * then every mod and the workflow are placed, and when one fails the ones placed before it are taken back, so a refused or failed file leaves nothing.
 */
function applyEnvelope(env: ModEnv, b: Record<string, unknown>): Promise<Reply> {
  for (const k of Object.keys(b)) if (k !== 'file' && k !== 'trust' && k !== 'replaceBuiltin') return Promise.resolve(fail(400, `\`${cap(k, 40)}\` is not a field of an envelope import.`));
  if (b.trust !== undefined && (!isObj(b.trust) || Object.keys(b.trust).length > MAX_MODS || !Object.values(b.trust).every((h) => typeof h === 'string'))) {
    return Promise.resolve(fail(400, '`trust` must name each mod you trust with the hash the preview showed: { "<mod id>": "<hash>" }.'));
  }
  const rb = b.replaceBuiltin;
  if (rb !== undefined && (!Array.isArray(rb) || rb.length > MAX_MODS || !rb.every((x) => typeof x === 'string'))) return Promise.resolve(fail(400, '`replaceBuiltin` must be a list of mod ids.'));
  const trust = new Map(Object.entries((b.trust ?? {}) as Record<string, string>));
  const replace = new Set((rb ?? []) as string[]);
  return serial(env.home, async () => {
    const o = openEnvelope(env, b.file);
    if ('reply' in o) return o.reply;
    const ids = new Set(o.mods.map((m) => m.id));
    for (const id of [...trust.keys(), ...replace]) if (!ids.has(id)) return fail(400, `${id$(id)} is named in your choices but is not a mod in the file. Nothing was installed.`);
    for (const m of o.mods) {
      if (m.summary.replaces === 'builtin' && !replace.has(m.id)) return fail(409, `This ${m.summary.replacesLine}. Import it again with ${id$(m.id)} in replaceBuiltin to go on. Nothing was installed.`);
      if (!trust.has(m.id)) continue;
      if (!m.summary.hasCode) return fail(400, `${id$(m.id)} has no code, so there is nothing to trust. Nothing was installed.`);
      if (trust.get(m.id) !== m.summary.hash) return fail(409, `${id$(m.id)} is not the code you were shown. Look at it again. Nothing was installed.`);
    }
    if (o.workflow && there(workflowFile(env.home, o.workflow.name))) return fail(409, `A playbook named ${o.workflow.name} is already saved. Nothing was installed.`);
    const placed: Placed[] = [];
    const back = () => placed.reverse().flatMap((p) => p.undo());
    const stop = (status: number, error: string): Reply => {
      const stuck = back();
      return fail(stuck.length ? 500 : status, stuck.length ? `${error} Taking back what was installed failed: ${stuck.join('; ')}.` : `${error} Nothing from this file was installed.`);
    };
    for (const m of o.mods) {
      const r = placeMod(env, m, trust.has(m.id));
      if ('reply' in r) return stop(r.reply.status, String((r.reply.body as { error?: unknown }).error));
      placed.push(r.placed);
    }
    if (o.workflow) {
      const s = saveWorkflow(env.home, o.workflow);
      if (typeof s === 'string') return stop(409, s);
      placed.push({ had: false, undo: () => { s.undo(); return []; }, commit: () => [] });
    }
    const left = placed.flatMap((p) => p.commit());
    const r = await reloaded(env, { ids: o.mods.map((m) => m.id) });
    const body = r.body as Record<string, unknown>;
    if (left.length) body.problems = [...(Array.isArray(body.problems) ? body.problems : []), ...left];
    body.trust = Object.fromEntries(o.mods.filter((m) => m.summary.hasCode).map((m) => { const now = entry(env, m.id); return [m.id, now ? trustOf(env, now) : 'none']; }));
    if (o.workflow) body.workflow = { name: o.workflow.name, diagnostics: unknownKinds(o.workflow.text, o.brings) };
    return r;
  });
}

/** What a workflow text uses: the step kinds, the condition atoms (a step's `cond` and the `whenever` autos) and the card kinds, and the files its blocks read from this computer. */
interface Uses { kinds: Set<string>; conds: Set<string>; cards: Set<string>; reads: Map<string, string> }

/** The `reads` of a block mod's manifest (`{ noun, folder, name: [where the step keeps the file's name] }`), read as plain names only; undefined when it has none. */
function readsOf(m: LoadedMod | undefined): { noun: string; folder: string; name: string[] } | undefined {
  const r = isObj(m?.manifest) ? m.manifest.reads : undefined;
  if (!isObj(r) || typeof r.noun !== 'string' || typeof r.folder !== 'string' || !NAME.test(r.noun) || !NAME.test(r.folder) || !Array.isArray(r.name)) return undefined;
  return { noun: r.noun, folder: r.folder, name: r.name.filter((k): k is string => typeof k === 'string' && NAME.test(k)).slice(0, 4) };
}

/** The mod that holds `name` in its `provides.<key>`: the user's first (a Customize copy included), else the bundled one. */
function holder(env: ModEnv, key: string, name: string): LoadedMod | undefined {
  const has = (m: LoadedMod) => namesOf(isObj(m.manifest) ? m.manifest.provides : undefined, key).includes(name);
  return env.mods.mods.find((m) => m.source === 'user' && has(m)) ?? env.mods.mods.find(has);
}

/** Everything the steps of a workflow text use (nested steps and else branches too). */
function usesOf(env: ModEnv, text: string): Uses {
  const out: Uses = { kinds: new Set(), conds: new Set(), cards: new Set(), reads: new Map() };
  const atoms = (c: Parameters<typeof condAtoms>[0]) => { for (const a of condAtoms(c)) out.conds.add(a.t); };
  const walk = (steps: Step[]) => {
    for (const s of steps) {
      out.kinds.add(s.kind);
      atoms(s.cond);
      for (const c of s.cards ?? []) out.cards.add(c.kind);
      const reads = readsOf(holder(env, 'kinds', s.kind));
      const file = reads?.name.map((k) => (k === 'title' ? s.title : s.attrs?.[k])).find((v) => typeof v === 'string' && v.trim() !== '');
      if (reads && file) out.reads.set(`${reads.noun} ${file}`, `The ${reads.noun} ${cap(file, 80)} is a file in your ${reads.folder} folder and is not in this file. Whoever imports the file needs a ${reads.noun} with that name.`);
      walk(s.kids ?? []);
      walk(s.else ?? []);
    }
  };
  const parsed = parseWorkflow(text).workflow;
  walk(parsed?.steps ?? []);
  for (const a of parsed?.autos ?? []) { atoms(a.cond); out.cards.add(a.card.kind); }
  return out;
}

/**
 * Exports mods, and optionally a workflow, as one envelope. `ids` are mods to include; the mods the workflow's blocks, conditions (a step's `cond` and the
 * `whenever` autos) and cards come from are added: the user's mods and any Customize copy. Something that ships with Reins is never exported. A block no
 * installed mod brings is named in `notes`, and so is each file a block reads from this computer (a mod's `reads`: the playbook files in `blocks/`), once per
 * name: those files are not carried. The file still holds the workflow.
 */
export function exportBundle(env: ModEnv, b: Record<string, unknown>): Reply {
  for (const k of Object.keys(b)) if (k !== 'ids' && k !== 'workflow') return fail(400, `\`${cap(k, 40)}\` is not a field of an export request.`);
  if (b.ids !== undefined && (!Array.isArray(b.ids) || b.ids.length > MAX_MODS || !b.ids.every(isModId))) return fail(400, '`ids` must be a list of mod ids (at most 20).');
  const w = b.workflow === undefined ? undefined : workflowOf(env, b.workflow);
  if (typeof w === 'string') return fail(400, w);
  const want = new Set<string>((b.ids ?? []) as string[]);
  if (!want.size && !w) return fail(400, 'Say which mods or which playbook to export.');
  const notes: string[] = [];
  const missing: string[] = [];
  for (const id of want) {
    const m = entry(env, id);
    if (!m) return fail(404, `No mod ${id$(id)} is installed.`);
    if (m.source === 'bundled') return fail(409, `${id$(id)} ships with Reins, so it is not exported.`);
  }
  if (w) {
    const used = usesOf(env, w.text);
    for (const kind of used.kinds) {
      const m = holder(env, 'kinds', kind);
      if (m?.source === 'user') want.add(m.id);
      else if (!m && !NODES.has(kind) && !missing.includes(kind)) {
        missing.push(kind);
        notes.push(`The block ${show(kind)} is brought by no mod installed here, so no mod for it is in the file. Whoever imports the file needs that mod.`);
      }
    }
    // A condition or card mod of the user's goes in the file like a block mod; the ones that ship with Reins never do.
    for (const [key, names] of [['conditions', used.conds], ['cards', used.cards]] as const) {
      for (const name of names) {
        const m = holder(env, key, name);
        if (m?.source === 'user') want.add(m.id);
      }
    }
    notes.push(...used.reads.values());
  }
  const mods: Record<string, Record<string, string>> = {};
  for (const id of [...want].sort()) {
    const r = exportMod(env, id);
    if (r.status !== 200) return r;
    mods[id] = (r.body as { files: Record<string, string> }).files;
  }
  const file = { reinsMods: 1, mods, ...(w ? { workflow: { name: w.name, text: w.text } } : {}) };
  const text = JSON.stringify(file, null, 2) + '\n';
  if (Buffer.byteLength(text) > MAX_TOTAL) return fail(409, 'The file would be larger than 1 MB, so nothing was exported.');
  const check = openEnvelope(env, text);
  if ('reply' in check) return fail(409, `The file would not import (${String((check.reply.body as { error?: unknown }).error)}), so nothing was exported.`);
  return { status: 200, body: { text, ids: Object.keys(mods), notes, missing }, headers: { 'content-disposition': 'attachment; filename="playbook.reins-mods.json"' } };
}
