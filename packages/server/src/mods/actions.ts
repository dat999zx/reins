// The settings actions for provider mods (spec 7.3 to 7.5): list, install, custom, edit, enable, disable, remove, re-install.
// Plain functions over a Reins home and the loaded mods; the server only routes to them. Every manifest is checked with the loader's own
// `validateMod` before a byte is written, a file is written whole (temp file, then rename), and the loader is asked to read again after.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setKey } from '../secrets.js';
import { cap, show } from './kinds.js';
import { isModId, validateMod } from './loader.js';
import type { LoadedMod, Mods, Protocol } from './types.js';

export type Reply = { status: number; body: unknown };
export interface ModEnv {
  /** The Reins folder (`~/.reins`). */
  home: string;
  /** `catalog/<id>/mod.json`, the providers the chooser offers. May not exist. */
  catalogDir: string;
  mods: Mods;
}

const MAX_MANIFEST = 256 * 1024;
const fail = (status: number, error: string): Reply => ({ status, body: { error } });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const id$ = (id: string) => `\`${cap(id, 40)}\``;

const modsDir = (home: string) => path.join(home, 'mods');
const disabledFile = (home: string) => path.join(home, 'disabled-mods.json');
/** The marker Task 22's `POST /api/mods/first-run/done` writes. */
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
  for (const k of ['baseUrl', 'modelsUrl'] as const) {
    const v = raw[k];
    try {
      if (typeof v === 'string' && (new URL(v).username || new URL(v).password)) return [`${id$(id)}: \`${k}\` must not hold a user name or password. Keys go in Settings > Providers, never in a mod.`];
    } catch { /* the validator worded it */ }
  }
  return [];
}
const refusal = (problems: string[]): Reply => ({ status: 400, body: { error: problems.join(' '), problems } });

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

function summary(env: ModEnv, m: LoadedMod) {
  const man = isObj(m.manifest) ? m.manifest : {};
  return {
    id: m.id, kind: m.kind, label: typeof man.label === 'string' ? man.label : m.id, version: typeof man.version === 'string' ? man.version : '',
    enabled: m.enabled, bundled: m.source === 'bundled',
    // A user mod is "installed" when the catalog has that id (custom endpoints may not take a catalog id), else it is the user's own.
    source: m.source === 'bundled' ? 'bundled' : readCatalog(env, m.id) ? 'installed' : 'custom',
    ...(m.replaces ? { replaces: m.replaces } : {}),
    problems: m.problems,
  };
}

/** The catalog providers not installed yet. `claude-code` is built in and never offered. */
function chooser(env: ModEnv) {
  return catalogIds(env).flatMap((id) => {
    const raw = readCatalog(env, id);
    if (!raw || id === 'claude-code' || exists(env, id) || problemsOf(env, raw, id).length) return [];
    const auth = isObj(raw.auth) && Array.isArray(raw.auth.keyEnv) ? raw.auth.keyEnv.filter((x): x is string => typeof x === 'string') : [];
    let host = '';
    try { host = new URL(String(raw.baseUrl)).host; } catch { /* validated above */ }
    return [{
      id, label: String(raw.label), description: typeof raw.description === 'string' ? raw.description : '',
      protocol: String(raw.protocol), host, keyEnv: auth, untested: raw.untested === true,
    }];
  });
}

export function listMods(env: ModEnv): Reply {
  // First run: the marker was never written and no provider besides the built-in ones was installed.
  const firstRun = !there(firstRunFile(env.home)) && !env.mods.mods.some((m) => m.kind === 'provider' && m.source === 'user');
  return { status: 200, body: { mods: env.mods.mods.map((m) => summary(env, m)), firstRun, chooser: chooser(env), problems: env.mods.problems } };
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
  const models = b.models ?? (typeof b.defaultModel === 'string' ? [{ id: b.defaultModel }] : undefined);
  const raw: Record<string, unknown> = { reins: 1, id, kind: 'provider', version: '1.0.0' };
  for (const k of ['label', 'description', 'protocol', 'baseUrl', 'modelsUrl', 'defaultModel', 'price', 'efforts', 'defaultEffort'] as const) if (b[k] !== undefined) raw[k] = b[k];
  raw.auth = auth.auth;
  if (models !== undefined) raw.models = models;
  return serial(env.home, async () => {
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
    // The key (secrets file) stays: a later install of the same id finds it again. The on/off mark goes with the mod.
    const off = readDisabled(env.home);
    if (off.delete(id)) writeWhole(env.home, disabledFile(env.home), JSON.stringify([...off].sort(), null, 2) + '\n');
    return reloaded(env, { id });
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
    const old = scratch(env.home, 'old');
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
    return reloaded(env, { id });
  });
}
