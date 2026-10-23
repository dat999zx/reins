import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { questionRefusal } from '../questions/index.js';
import { checkMode, policyOf, register as registerNode, registerCard, registerCondition, turnInstr } from '@reins/core';
import type { NodeType } from '@reins/core';
import { cap, kindIds, kindOf, kindsInOrder, show } from './kinds.js';
import { Registry } from './registry.js';
import type { Carried, LoadedMod, LoadOptions, ModApi, ModHost, Mods, ModSource, Problem, Protocol, Provides } from './types.js';

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const RESERVED = /^(nul|con|prn|aux|com[1-9]|lpt[1-9])$/i;
const MAX_MANIFEST = 256 * 1024;
const MAX_DEPTH = 32;
/** How long a mod's `activate` may take before it fails. An object so a test can shorten it. */
export const ACTIVATE = { ms: 10_000 };

interface Found {
  folder: string;
  dir: string;
  source: ModSource;
  file: string;
  /** Set when mod.json could not be read or parsed. */
  error?: string;
  raw?: Record<string, unknown>;
}

interface Bytes {
  rel: string;
  bytes: Buffer;
}

/** Something wrong with one mod; the message is already a plain problem line. */
class ModError extends Error {}

/** Every thrown value becomes bounded text: nothing is read from it that could throw. */
function errorText(e: unknown): string {
  try {
    return cap(e instanceof Error && typeof e.message === 'string' ? e.message : show(e), 200);
  } catch {
    return show(e);
  }
}

/** Text with the Reins home (as a path in either slash style, or as a file address) written as `~/.reins`. Case-insensitive on Windows. */
function homeScrubber(home: string): (text: string) => string {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const forms = new Set<string>([home, home.replaceAll('\\', '/'), home.replaceAll('/', '\\'), pathToFileURL(home).href, pathToFileURL(home).href.replace(/^file:\/\/\//, 'file://')]);
  const re = new RegExp([...forms].filter(Boolean).map(esc).sort((a, b) => b.length - a.length).join('|'), process.platform === 'win32' ? 'gi' : 'g');
  return (text) => text.replace(re, '~/.reins');
}

const linkMsg =(id: string, rel: string) => `\`${id}\`: a link inside the mod folder is not allowed: ${cap(rel, 120)}.`;

/** `~/.reins/mods/x/mod.json` for a file under home, the full path otherwise. */
const shown = (file: string, home: string) => {
  const rel = path.relative(home, file);
  return `\`${rel.startsWith('..') || path.isAbsolute(rel) ? file : `~/.reins/${rel.split(path.sep).join('/')}`}\``;
};

// ponytail: node's message has no position, so the line is the first one holding the unexpected character; a position or line in the message wins.
function jsonLine(text: string, message: string): number {
  const pos = /position (\d+)/.exec(message);
  if (pos) return text.slice(0, Number(pos[1])).split('\n').length;
  const line = /line (\d+)/.exec(message);
  if (line) return Number(line[1]);
  const tok = /Unexpected token '(.)'/.exec(message)?.[1];
  const at = tok === undefined ? -1 : text.indexOf(tok);
  return at < 0 ? text.split('\n').length : text.slice(0, at).split('\n').length;
}

/** How deep the brackets nest, ignoring strings. A plain loop, so a hostile file cannot overflow the stack. */
function depthOf(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') max = Math.max(max, ++depth);
    else if (c === '}' || c === ']') depth--;
  }
  return max;
}

/** Size and depth are checked before the JSON is parsed, and so before any validator sees it. */
export function parseManifest(buf: Buffer, file: string): { raw: Record<string, unknown> } | { error: string } {
  if (buf.length > MAX_MANIFEST) return { error: `${file}: is larger than 256 KB; a manifest this big is refused.` };
  const text = buf.toString('utf8');
  if (depthOf(text) > MAX_DEPTH) return { error: `${file}: is nested more than ${MAX_DEPTH} levels deep; a manifest this deep is refused.` };
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: `${file}: the file must hold one JSON object.` };
    return { raw: raw as Record<string, unknown> };
  } catch (e) {
    const message = errorText(e);
    const plain = /^(Unexpected token '.')/.exec(message)?.[1].replace(/'/g, '') ?? message.split('\n')[0];
    return { error: `${file}: not valid JSON at line ${jsonLine(text, message)}: ${plain}.` };
  }
}

/** At most MAX_MANIFEST + 1 bytes of a file, however big it is or grows: one byte over is enough to refuse it. */
function readCapped(file: string): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(MAX_MANIFEST + 1);
    return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0));
  } finally {
    fs.closeSync(fd);
  }
}

/** Reads and parses one mod.json. Only a plain file is read; a link is refused. */
function readManifest(folder: string, file: string, home: string): { raw: Record<string, unknown> } | { error: string } {
  const label = shown(file, home);
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) return { error: linkMsg(folder, 'mod.json') };
    if (st.size > MAX_MANIFEST) return { error: `${label}: is larger than 256 KB; a manifest this big is refused.` };
    return parseManifest(readCapped(file), label);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return { error: code === 'ENOENT' ? `\`${folder}\`: ${label} is missing.` : `\`${folder}\`: ${label} could not be read (${cap(String(code ?? errorText(e)), 40)}).` };
  }
}

// Only a missing folder means "no mods"; any other failure is returned as a problem for the whole load.
// The mods root itself may be a link, on purpose (a user may link it to a dotfiles repo); links INSIDE it are refused.
function scan(dir: string, source: ModSource, home: string): { found: Found[]; problem?: Problem } {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return { found: [] };
    return { found: [], problem: `${shown(dir, home)}: the mods folder could not be read (${cap(String(code ?? errorText(e)), 40)}).` };
  }
  const found = entries
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((d): Found => {
      const mdir = path.join(dir, d.name);
      const file = path.join(mdir, 'mod.json');
      const f: Found = { folder: d.name, dir: mdir, source, file };
      if (d.isSymbolicLink()) return { ...f, error: linkMsg(d.name, d.name) };
      const r = readManifest(d.name, file, home);
      return 'error' in r ? { ...f, error: r.error } : { ...f, raw: r.raw };
    });
  return { found };
}

/**
 * Every file of a mod folder, once, in memory. A link or junction anywhere is refused: the folder itself and every
 * directory and file are checked with lstat when they are read, not only by the entry list read before. A top-level
 * mod.json is read with the manifest ceiling.
 */
export function readFolder(dir: string, id: string, base = ''): Bytes[] {
  const here = path.join(dir, base);
  if (fs.lstatSync(here).isSymbolicLink()) throw new ModError(linkMsg(id, base || path.basename(dir)));
  const out: Bytes[] = [];
  for (const d of fs.readdirSync(here, { withFileTypes: true })) {
    const rel = base ? `${base}/${d.name}` : d.name;
    if (d.isSymbolicLink()) throw new ModError(linkMsg(id, rel));
    if (d.isDirectory()) out.push(...readFolder(dir, id, rel));
    else if (d.isFile()) {
      const file = path.join(dir, rel);
      if (fs.lstatSync(file).isSymbolicLink()) throw new ModError(linkMsg(id, rel));
      out.push({ rel, bytes: rel === 'mod.json' ? readCapped(file) : fs.readFileSync(file) });
    }
  }
  return out;
}

/** Two files whose paths differ only in case would overwrite each other in a case-insensitive cache. */
export function caseAlias(rels: string[]): [string, string] | undefined {
  const seen = new Map<string, string>();
  for (const r of rels) {
    const k = r.toLowerCase();
    const other = seen.get(k);
    if (other !== undefined) return [other, r];
    seen.set(k, r);
  }
  return undefined;
}

/** SHA-256 over every file, sorted by path; the path and the length frame each file (as trust.ts does for its files). */
export function hashFiles(files: Bytes[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    h.update(`${f.rel}\0${f.bytes.length}\0`);
    h.update(f.bytes);
    h.update('\0');
  }
  return h.digest('hex');
}

const sameFiles = (a: Bytes[], b: Bytes[]) => {
  if (a.length !== b.length) return false;
  const byRel = new Map(b.map((x) => [x.rel, x.bytes]));
  return a.every((x) => byRel.get(x.rel)?.equals(x.bytes) === true);
};

/**
 * S15: the folder code is imported from. Built in a fresh folder made exclusively beside its final name (never
 * in one that exists), checked, then renamed in. A final folder that is already there and holds exactly these
 * files is reused; one that does not is never rebuilt (code may have been imported from it). A link at the
 * cache root, the staging folder or the final folder is refused.
 */
function publish(home: string, hash: string, files: Bytes[], id: string): string {
  const root = path.join(home, 'mod-cache');
  const final = path.join(root, hash);
  const matches = (dir: string) => {
    try {
      return sameFiles(readFolder(dir, id), files);
    } catch {
      return false;
    }
  };
  const noLink = (p: string) => {
    if (fs.lstatSync(p).isSymbolicLink()) throw new ModError(`\`${id}\`: ${shown(p, home)} is a link, which is not allowed in the code cache.`);
  };
  fs.mkdirSync(root, { recursive: true });
  noLink(root);
  if (fs.existsSync(final)) {
    noLink(final);
    if (matches(final)) return final;
    throw new ModError(`\`${id}\`: ${shown(final, home)} exists but does not hold this code; remove that folder to go on.`);
  }
  let tmp: string | undefined;
  try {
    tmp = fs.mkdtempSync(path.join(root, `${hash}.tmp-`));
    noLink(tmp);
    for (const x of files) {
      fs.mkdirSync(path.dirname(path.join(tmp, x.rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, x.rel), x.bytes);
    }
    if (!matches(tmp)) throw new ModError(`\`${id}\`: the copy of its code could not be written correctly.`);
    try {
      fs.renameSync(tmp, final);
    } catch (e) {
      if (!fs.existsSync(final)) throw new ModError(`\`${id}\`: its code could not be put in the cache (${errorText(e)}).`);
      noLink(final); // another load published the same hash first: use theirs if it is exactly this code
      if (!matches(final)) throw new ModError(`\`${id}\`: ${shown(final, home)} exists but does not hold this code; remove that folder to go on (${errorText(e)}).`);
    }
  } finally {
    // Best effort: a failed clean-up never hides the error that is already on its way out.
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* a leftover <hash>.tmp-* folder is harmless and unused */
      }
    }
  }
  return final;
}
/** One spelling of `main`: slashes, normalised, inside the folder. Undefined when it is not a file path inside the folder. */
export function canonMain(main: unknown): string | undefined {
  if (typeof main !== 'string' || main.length > 200) return undefined;
  const m = path.posix.normalize(main.replaceAll('\\', '/'));
  if (m === '.' || m.endsWith('/') || m === '..' || m.startsWith('../') || m.startsWith('/') || /^[a-z]:/i.test(m)) return undefined;
  return m;
}

/** The checks every kind shares. Returns what is wrong, in plain words. */
function commonProblems(raw: Record<string, unknown>, f: Pick<Found, 'folder' | 'source'>, id: string, bundledKinds: Map<string, string>): Problem[] {
  const bad = (msg: string): Problem[] => [`\`${id}\`: ${msg}`];
  if (RESERVED.test(f.folder) || RESERVED.test(id)) return bad('this id is a reserved name on Windows; pick another.');
  if (raw.reins !== 1) return bad(raw.reins === undefined ? '`reins` is missing; it must be 1.' : `\`reins\` is ${show(raw.reins)}; this Reins reads manifests with \`reins\` 1.`);
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) {
    return bad('the id must be lowercase letters, digits and dashes, start with a letter or digit, and be at most 40 long.');
  }
  if (f.folder !== id) return bad(`the folder is \`${cap(f.folder, 80)}\` but the id is \`${id}\`; they must be the same.`);
  if (typeof raw.kind !== 'string') return bad('`kind` must be text.');
  const kind = raw.kind;
  if (!kindOf(kind)) return bad(`\`kind\` is ${show(kind)}, which Reins does not know. Known: ${kindIds().join(', ')}.`);
  const other = bundledKinds.get(id);
  if (f.source === 'user' && other !== undefined && other !== kind) return [`\`${id}\` is the id of a built-in ${other}; pick another id.`];
  // `pack` and `required` are the built-in mods' own words: a user mod that claims either is refused, whatever the value.
  if (f.source === 'user') {
    for (const key of ['pack', 'required'] as const) {
      if (raw[key] !== undefined) return bad(`\`${key}\` is for the mods that ship with Reins. A mod of yours cannot say it; take it out of mod.json.`);
    }
  } else {
    if (raw.pack !== undefined && raw.pack !== 'default') return bad(`\`pack\` is ${show(raw.pack)}; it must be "default".`);
    if (raw.required !== undefined && raw.required !== true) return bad(`\`required\` is ${show(raw.required)}; it must be true or left out.`);
  }
  const out: Problem[] = [];
  for (const key of ['version', 'label'] as const) {
    if (typeof raw[key] !== 'string' || raw[key] === '') out.push(...bad(`\`${key}\` is missing.`));
  }
  if (raw.main !== undefined && canonMain(raw.main) === undefined) out.push(...bad('`main` must be a file inside the mod folder.'));
  return out;
}

/** The id rule, whole: the shape and not a Windows reserved name. Settings actions check every id with this before any file is touched. */
export const isModId = (id: unknown): id is string => typeof id === 'string' && ID.test(id) && !RESERVED.test(id);

/** The loader's whole check of one manifest: the common checks, then the kind's own. The settings actions run the same function before they write. */
export function validateMod(raw: Record<string, unknown>, f: { folder: string; source: ModSource }, id: string, bundledKinds: Map<string, string>, registry: Registry): Problem[] {
  const common = commonProblems(raw, f, id, bundledKinds);
  if (common.length) return common;
  return kindOf(raw.kind as string)!.validate(raw, { id, registry, source: f.source }).slice(0, 20); // a hostile file cannot flood the list
}

/** Everything one mod must undo: its registry entries and whatever else a kind handed back. */
interface Tx {
  undo: Array<() => void>;
}

/** A carried bundled mod and a user mod of the same id are two entries in `carry`; the bundled one's key starts with this. */
const BUNDLED_KEY = 'bundled:';
const keyOf = (kindId: string, id: string, source: ModSource) => `${source === 'bundled' ? BUNDLED_KEY : ''}${kindId}:${id}`;

/** What a mod says when a hand-edited off list names a required id: it stays on. The ending is what Settings reads as news, not a fault. */
export const REQUIRED_TAIL = ': is required, so it stays on.';
const requiredNote = (id: string) => `\`${id}\`${REQUIRED_TAIL} Reins ignored the switch-off in disabled-mods.json.`;

/** Newest first. One failing disposer never stops the others, and never replaces the error that caused the clean-up. */
const stop = (tx: Tx) => {
  const all = tx.undo.splice(0).reverse();
  for (const d of all) {
    try {
      d();
    } catch {
      /* clean-up is best effort */
    }
  }
};

/** Whether a mod that replaces a built-in may cover the entry `name` of the registry `what`. */
type May = (what: string, name: string) => boolean;
const NEVER: May = () => false;

/** The registry entries that hold a name from the built-in's `provides`, and the list that name must be in. */
const OWN_LIST = new Map<string, keyof Provides>([['block-view', 'kinds'], ['cond-view', 'conditions'], ['card-view', 'cards']]);

/**
 * A mod that replaces a built-in covers only what the built-in itself brought: the names its `provides` lists (kinds, conditions, cards), its
 * own record, and the protocol it is named for. Anything else it registers must be new, so a copy of one mod cannot take another's kind.
 */
function mayShadow(was: LoadedMod | undefined, id: string): May {
  if (!was) return NEVER;
  const own = (was.manifest as { provides?: Provides } | undefined)?.provides;
  return (what, name) => {
    const list = OWN_LIST.get(what);
    if (list) return own?.[list]?.includes(name) === true;
    return what === 'protocol-impl' ? name === id : true;
  };
}

/** The registry, with every `register` call's disposer written down in `tx`. A shadowing mod goes on top of the entries `may` allows. */
function track(registry: Registry, tx: Tx, may: May): Registry {
  const t = Object.create(registry) as Registry;
  t.register = (kind, id, value) => {
    const d = registry.register(kind, id, value, { shadow: may(kind, id) });
    tx.undo.push(d);
    return d;
  };
  return t;
}

const frozen = <T extends object | undefined>(v: T): T => (v !== null && typeof v === 'object' ? (Object.freeze(Array.isArray(v) ? [...v] : { ...v }) as T) : v);

/**
 * A node copied once into plain frozen data, so what is checked is what core stores: a getter cannot answer differently the second time.
 * The copy carries the mod mark (this mod's id and `provides.events`); only this function sets it, and it overwrites whatever the node said, so
 * core guards the node (guard.ts) and holds a wrapped `vm.log` to those events.
 */
function nodeCopy(node: NodeType, id: string, provides: Provides, pack: boolean): NodeType {
  if (typeof node !== 'object' || node === null) throw new Error('registerBlock needs a node object.');
  const n = { ...node, mod: Object.freeze({ id, events: Object.freeze([...(provides.events ?? [])]), ...(pack ? { pack: true as const } : {}) }) };
  n.attrs = frozen(n.attrs);
  n.ops = frozen(n.ops);
  n.count = frozen(n.count);
  n.print = frozen(n.print);
  if (n.heading) n.heading = Object.freeze({ ...n.heading, owns: frozen(n.heading.owns) });
  return Object.freeze(n);
}

const copyOf = <T extends object>(what: string, v: T): T => {
  if (typeof v !== 'object' || v === null) throw new Error(`${what} needs an object.`);
  return Object.freeze({ ...v });
};

/** A condition or card from a mod's code carries no editor data: that comes from the manifest, checked, and code never hands it over. */
const viewless = <T extends { view?: unknown }>(v: T): T => {
  const { view: _gone, ...rest } = v;
  return Object.freeze(rest) as T;
};

/** Each thing a mod can register: the mod kind that may, the copy it is checked and stored from, what `provides` must list, and the core call. */
interface Door<T> {
  kind: string;
  copy(item: T, id: string, provides: Provides, pack: boolean): T;
  /** Throws, in words, for anything `provides` does not list. */
  check(item: T, has: (key: keyof Provides, name: unknown, what: string) => void): void;
  /** `pack`: the mod is one of the default pack (only a bundled manifest can say so). */
  put(item: T, order: number, may: May, pack: boolean): () => void;
}
const DOORS: { [M in 'registerBlock' | 'registerCondition' | 'registerCard']: Door<Parameters<ModApi[M]>[0]> } = {
  registerBlock: {
    kind: 'block',
    copy: nodeCopy,
    check(n, has) {
      has('kinds', n.kind, 'the kind');
      if (!Array.isArray(n.attrs) || n.attrs.some((a) => typeof a !== 'string')) throw new Error('`attrs` must be a list of names.');
      for (const a of n.attrs) has('attrs', a, 'the attribute');
      for (const a of n.heading?.owns ?? []) has('attrs', a, 'the heading key');
      for (const op of Object.keys(n.ops ?? {})) has('ops', op, 'the op');
      for (const ev of Object.keys(n.count ?? {})) has('events', ev, 'the counted event');
      for (const ev of Object.keys(n.print ?? {})) has('events', ev, 'the printed event');
    },
    // `chatTurn` names the block every chat message is wrapped in: only the default pack, or a copy of one of its blocks, may claim it.
    put: (n, order, may, pack) => registerNode(n.chatTurn === true && !pack && !may('block-view', n.kind) ? Object.freeze({ ...n, chatTurn: undefined }) : n, order, { shadow: may('block-view', n.kind) }),
  },
  registerCondition: {
    kind: 'condition',
    copy: (c) => viewless(copyOf('registerCondition', c)),
    check: (c, has) => has('conditions', c.t, 'the condition'),
    put: (c, order, may) => registerCondition(c, order, { shadow: may('cond-view', c.t) }),
  },
  registerCard: {
    kind: 'card',
    copy: (c) => viewless(copyOf('registerCard', c)),
    check: (c, has) => has('cards', c.kind, 'the card'),
    put: (c, order, may) => registerCard(c, order, { shadow: may('card-view', c.kind) }),
  },
};

/**
 * The api of ONE mod: it can register only what its kind allows and its `provides` lists, and every function member throws once `close()` is
 * called (when `activate` has settled). What a mod puts in core goes in `tx` (the undo list the caller passes), so a failed activation takes it out again.
 */
function buildApi(kindId: string, raw: Record<string, unknown>, env: NodeJS.ProcessEnv, registry: Registry, tx: Tx, may: May): { api: ModApi; close(): void } {
  let open = true;
  const provides = (typeof raw.provides === 'object' && raw.provides !== null ? raw.provides : {}) as Provides;
  const order = typeof raw.order === 'number' ? raw.order : NaN;
  const has = (key: keyof Provides, name: unknown, what: string) => {
    if (typeof name !== 'string' || !provides[key]?.includes(name)) throw new Error(`\`provides.${key}\` does not list ${what} ${show(name)}.`);
    const q = questionRefusal(key, name); // the manifest check refuses it too; this is the api's own
    if (q) throw new Error(q);
  };
  const live = <A extends unknown[], R>(f: (...a: A) => R) => (...a: A): R => {
    if (!open) throw new Error('the api can only be used while the mod activates.');
    return f(...a);
  };
  const doors = Object.fromEntries(
    Object.entries(DOORS).map(([member, d]) => [member, live((item: never) => {
      const door = d as Door<typeof item>;
      if (door.kind !== kindId) throw new Error(`\`${member}\` is for ${door.kind} mods; this is a ${kindId} mod.`);
      const copy = door.copy(item, typeof raw.id === 'string' ? raw.id : kindId, provides, raw.pack === 'default');
      door.check(copy, has);
      const undo = door.put(copy, order, may, raw.pack === 'default');
      tx.undo.push(undo);
      return undo;
    })]),
  ) as Pick<ModApi, keyof typeof DOORS>;
  const api: ModApi = Object.freeze({
    env,
    registerProtocol: live((p: Protocol) => registry.register('protocol-impl', p.id, p)),
    ...doors,
    core: Object.freeze({ checkMode, policyOf, turnInstr }),
  });
  return { api, close: () => { open = false; } };
}

/** The problem line for anything thrown. Cannot throw itself: a revoked proxy is as good as any other value. */
function thrownLine(e: unknown, id: string): string {
  let ours = false;
  try {
    ours = e instanceof ModError;
  } catch {
    /* a revoked proxy: not ours */
  }
  return ours ? (e as ModError).message : `\`${id}\`: failed while loading: ${errorText(e)}`;
}
export async function loadMods(o: LoadOptions): Promise<Mods> {
  const env = o.env ?? process.env;
  const registry = new Registry();
  const mods: LoadedMod[] = [];
  const txs = new Map<LoadedMod, Tx>();
  const active = new Map<string, LoadedMod>(); // `<kind>:<id>` of the mods now registered
  const listed = new Set<Found>();
  const problems: Problem[] = [];

  const b = scan(o.bundledDir, 'bundled', o.home);
  const u = scan(o.userDir, 'user', o.home);
  for (const s of [b, u]) if (s.problem) problems.push(s.problem);
  const all = [...b.found, ...u.found];
  const bundledKinds = new Map<string, string>();
  for (const f of b.found) if (typeof f.raw?.kind === 'string') bundledKinds.set(f.folder, f.raw.kind);
  // The ids that cannot be switched off: only a bundled manifest can say so (a user mod that says it is refused by `commonProblems`).
  const required = new Set(b.found.filter((f) => f.raw?.required === true).map((f) => f.folder));
  const forced = new Set<string>(); // required ids a hand-edited off list named: they stay on, and say so

  o.afterScan?.();

  const idOf = (raw: Record<string, unknown> | undefined, folder: string) => (typeof raw?.id === 'string' && ID.test(raw.id) ? raw.id : folder);
  const list = (f: Found, id: string, kind: string, problems: Problem[]): LoadedMod => {
    listed.add(f);
    const mod: LoadedMod = {
      id, kind, source: f.source, dir: f.dir, enabled: true, hasCode: f.raw?.main !== undefined,
      trusted: f.source === 'bundled', problems, manifest: f.raw,
      ...(required.has(id) ? { required: true as const } : {}),
      ...(f.source === 'bundled' && f.raw?.pack === 'default' ? { pack: 'default' as const } : {}),
    };
    mods.push(mod);
    return mod;
  };

  // A file that never parsed has no kind to wait for: list it now.
  for (const f of all) if (f.error) list(f, f.folder, '', [f.error]);

  // A startOnly mod's registrations in core outlive a load: they sit in `carry` (the caller's, or this load's own, undone by `dispose`).
  const carry = o.carry ?? new Map<string, Carried>();
  const held = new Set<string>(); // carried keys this load met
  const carriedBefore = new Set(carry.keys()); // what an earlier load of this process left in core
  const previews: Array<() => void> = []; // untrusted mods' manifest-only views, recorded after every activation

  const load = async (f: Found, kindId: string) => {
    const id = idOf(f.raw, f.folder);
    const mod = list(f, id, kindId, []);
    const tx: Tx = { undo: [] };
    const own: Tx = { undo: [] }; // what the mod put in core (startOnly kinds); `tx` holds only this load's registry entries
    // A bundled mod and a user mod of the same id are two carried mods (the user copy sits on top of the built-in in core): the built-in's key says so.
    const key = keyOf(kindId, id, f.source);
    try {
      const kind = kindOf(kindId)!;
      const carried = carry.get(key); // only startOnly mods are ever written to it
      const was = f.source === 'user' ? active.get(keyOf(kindId, id, 'bundled')) : undefined; // the built-in this mod replaces, if it is in force
      const replacing = was?.source === 'bundled';
      const may = replacing ? mayShadow(was, id) : NEVER;
      // The user copy of a built-in that is already in core waits for a restart (a live swap of a kind under running workflows is not made).
      const pending = replacing && !carried && carriedBefore.has(keyOf(kindId, id, 'bundled'));
      // The list shows the mod that is in force; the built-in stays registered underneath.
      const settle = () => {
        if (!replacing) return;
        const at = mods.indexOf(was!);
        if (at >= 0) mods.splice(at, 1);
        mod.replaces = 'bundled';
        const version = (was!.manifest as { version?: unknown } | undefined)?.version;
        if (typeof version === 'string') mod.builtinVersion = version;
        if (was!.pack) mod.pack = was!.pack;
      };
      // A carried mod is not activated again: its registry entries are recorded anew, from what it registered under. Anything but "same and in force" says so.
      const keep = (stale: boolean) => {
        txs.set(mod, tx);
        const d = kind.activate(stale ? { ...mod, manifest: carried!.manifest } : mod, { registry: track(registry, tx, may), env });
        if (d) tx.undo.push(d);
        active.set(key, mod);
        held.add(key);
        settle();
        if (stale) mod.problems.push(`\`${id}\`: applies after a restart.`);
      };
      if (o.disabled.has(id) && required.has(id)) forced.add(id); // a required id is never off, whatever the file says
      else if (o.disabled.has(id)) {
        mod.enabled = false;
        if (carried) keep(true);
        return;
      }
      let raw = f.raw!;
      let files: Bytes[] | undefined;
      if (f.source === 'user' && raw.main !== undefined) {
        // One snapshot: the manifest, the hash, `main` and the cache copy all come from these buffers.
        files = readFolder(f.dir, id);
        const alias = caseAlias(files.map((x) => x.rel));
        if (alias) throw new ModError(`\`${id}\`: two files differ only in upper and lower case: ${cap(alias[0], 80)}, ${cap(alias[1], 80)}.`);
        const mj = files.find((x) => x.rel === 'mod.json');
        const p = mj ? parseManifest(mj.bytes, shown(f.file, o.home)) : { error: `\`${id}\`: ${shown(f.file, o.home)} is missing.` };
        if ('error' in p) throw new ModError(p.error);
        raw = p.raw;
        if (raw.id !== f.raw!.id || raw.kind !== f.raw!.kind) throw new ModError(`\`${id}\`: mod.json changed while Reins was reading it.`);
        mod.manifest = raw;
        mod.hasCode = raw.main !== undefined;
      }
      mod.problems.push(...validateMod(raw, f, id, bundledKinds, registry));
      if (mod.problems.length) return;

      // A user mod replaces a bundled one of the same kind by shadowing it: the built-in is never touched while
      // the user mod activates. If activation fails only the user mod's entries go, and the built-in is still there.
      // It may cover only what the built-in's own `provides` lists (`mayShadow`).
      txs.set(mod, tx);
      const tracked = track(registry, tx, may);
      const host: ModHost = { registry: tracked, env };

      const main = canonMain(raw.main);
      let codeDir = f.dir;
      if (mod.hasCode && files) {
        if (!files.some((x) => x.rel === main)) {
          mod.problems.push(`\`${id}\`: \`main\` is \`${cap(String(main), 80)}\`, which is not in the mod folder.`);
          return;
        }
        mod.hash = hashFiles(files);
        mod.trusted = o.trusted(id, mod.hash) === true;
        if (!carried && !mod.trusted) {
          mod.problems.push(`\`${id}\`: needs trust. Its code is new, or a file changed since you trusted it. It has not run.`);
          // What the manifest alone shows (a block's view) is recorded without running anything; a mod that would replace a built-in records nothing.
          // It waits until every mod has activated: a preview must never take a name a trusted mod is about to register.
          if (!replacing && kind.preview) previews.push(() => {
            try {
              const shown = kind.preview!(mod, host);
              if (shown) tx.undo.push(shown);
            } catch (e) {
              mod.problems.push(`\`${id}\`: its view is not shown: ${errorText(e)}`);
            }
          });
          return;
        }
        if (!carried && !pending) {
          o.beforeActivate?.(mod);
          codeDir = publish(o.home, mod.hash, files, id);
        }
      }
      if (pending) {
        mod.problems.push(`\`${id}\`: applies after a restart.`);
        settle();
        return;
      }
      // Never trusted, copied or imported again: what registered in core stays. Another manifest or code, or trust taken back, waits for a restart.
      if (carried) return keep(sigOf(mod, raw) !== carried.sig || !mod.trusted);

      let activate: ((api: ModApi) => unknown) | undefined;
      if (mod.hasCode) {
        let m: { default?: unknown };
        try {
          // The cache is as trusted as the home folder: a process that can write there can already do anything the mod's code could (spec 5.6).
          m = (await import(/* @vite-ignore */ pathToFileURL(path.join(codeDir, main!)).href)) as { default?: unknown };
        } catch (e) {
          mod.problems.push(`\`${id}\`: its code did not load: ${errorText(e)}`);
          return;
        }
        if (typeof m.default !== 'function') {
          mod.problems.push(`\`${id}\`: its code did not load: it does not default-export a function.`);
          return;
        }
        activate = m.default as (api: ModApi) => unknown;
      } else {
        activate = kind.data?.(raw); // a mod with no code (a data block): what its manifest says, through the same api
      }

      try {
        const d = kind.activate(mod, host);
        if (d) tx.undo.push(d);
        if (activate) {
          const { api, close } = buildApi(kindId, raw, env, tracked, kind.startOnly ? own : tx, may);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            // An activate that never settles must not hold the start of the server: after the limit it fails like one that threw.
            await Promise.race([
              activate(api),
              new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`did not finish starting within ${ACTIVATE.ms / 1000} seconds.`)), ACTIVATE.ms); }),
            ]);
          } finally {
            clearTimeout(timer);
            close(); // settled, by return or by throw (or by the limit): from now on every member refuses
          }
        }
      } catch (e) {
        stop(tx);
        stop(own);
        mod.problems.push(replacing ? `\`${id}\`: could not replace the built-in \`${id}\`; the built-in stays: ${errorText(e)}` : `\`${id}\`: ${errorText(e)}`);
        return;
      }
      active.set(key, mod);
      if (kind.startOnly) {
        held.add(key);
        carry.set(key, { sig: sigOf(mod, raw), manifest: raw, source: f.source, dir: f.dir, hasCode: mod.hasCode, hash: mod.hash, undo: own.undo });
      }
      settle();
    } catch (e) {
      stop(tx);
      mod.problems.push(thrownLine(e, id));
    }
  };
  for (const kind of kindsInOrder()) {
    for (const f of all) {
      if (f.raw && f.raw.kind === kind.id) await load(f, kind.id);
    }
  }
  for (const record of previews) record();
  // Whatever no kind took (a kind that is not text, or not known) still gets its words.
  for (const f of all) {
    if (listed.has(f)) continue;
    const id = idOf(f.raw, f.folder);
    const why = commonProblems(f.raw!, f, id, bundledKinds);
    list(f, id, typeof f.raw?.kind === 'string' ? f.raw.kind : '', why.length ? why : [`\`${id}\`: this mod was not loaded.`]);
  }
  // A carried mod this load did not meet in force (removed, or its files no longer read) is still in core: its words, on its entry or on a stand-in.
  for (const [key, c] of carry) {
    if (held.has(key)) continue;
    const bare = c.source === 'bundled' ? key.slice(BUNDLED_KEY.length) : key;
    const [kindId, id] = [bare.slice(0, bare.indexOf(':')), bare.slice(bare.indexOf(':') + 1)];
    const notice = `\`${id}\`: applies after a restart.`;
    const there = mods.find((m) => m.id === id);
    if (there) {
      there.problems.push(notice);
      continue;
    }
    const stand: LoadedMod = { id, kind: kindId, source: c.source, dir: c.dir, enabled: true, hasCode: c.hasCode, trusted: true, hash: c.hash, problems: [notice], manifest: c.manifest };
    mods.push(stand);
    const tx: Tx = { undo: [] };
    txs.set(stand, tx);
    const d = kindOf(kindId)?.activate(stand, { registry: track(registry, tx, NEVER), env });
    if (d) tx.undo.push(d);
  }

  for (const m of mods) if (forced.has(m.id)) m.problems.push(requiredNote(m.id));

  // Node's own errors (a missing helper, a syntax error) name absolute paths; nothing the loader returns may show the home.
  const scrub = homeScrubber(o.home);
  for (const m of mods) m.problems = m.problems.map(scrub);
  return {
    mods,
    registry,
    problems: problems.map(scrub),
    dispose() {
      for (const tx of [...txs.values()].reverse()) stop(tx);
      txs.clear();
      if (!o.carry) dropCarried(carry); // a caller's carry outlives the load; this load's own goes with it
    },
  };
}

/** Undoes what every carried mod put in core, newest first, and forgets them. `startMods().dispose()` and a load with no `carry` of its own end here. */
export function dropCarried(carry: Map<string, Carried>): void {
  for (const c of [...carry.values()].reverse()) stop(c);
  carry.clear();
}

/** What a carried mod is compared by: its code hash (user code) and its manifest as the file spells it. */
const sigOf = (mod: LoadedMod, raw: Record<string, unknown>) => `${mod.hash ?? ''}\0${JSON.stringify(raw)}`;
