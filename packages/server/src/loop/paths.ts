// Path confinement for the loop's file tools (spec 4.3). Pure: the cwd, the Reins home, the platform and the fs come in as arguments.
// Order: a lexical refusal with no fs call, then the real path of the path and of the cwd, then the case rule, then the Reins home, then inside or outside.
import nodeFs, { type Stats } from 'node:fs';
import path from 'node:path';

/** The two fs calls confinement makes. Tests pass a spy or a fake. */
export interface FsLike {
  realpathSync: { native(p: string): string };
  lstatSync(p: string): unknown;
}

export interface ConfineCtx {
  cwd: string;
  /** The Reins home (host.home). Always refused, inside the cwd or not. */
  home: string;
  platform?: NodeJS.Platform;
  fs?: FsLike;
}

export type Confined =
  | { ok: true; abs: string; inside: boolean; /** The real cwd the path was judged against. */ root: string }
  | { ok: false; reason: string };

export const HOME_WORDS = 'Blocked by Reins: this path belongs to Reins itself.';
const shown = (p: string) => p.slice(0, 200).replace(/\0/g, '\\0');
export const LEXICAL_WORDS = (p: string) => `Blocked by Reins: Reins does not open network, device or short-name paths (${shown(p)}).`;
const UNRESOLVED_WORDS = (p: string) => `Blocked by Reins: Reins cannot tell where this path leads (${shown(p)}).`;
export const EMPTY_WORDS = 'Blocked by Reins: the path is empty.';

// A Windows device name, with or without an extension: CON.txt is still the console. Superscript digits count.
const DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9\u00b9\u00b2\u00b3])$/i;

/** The refusal words for a path no file tool may open, judged from the text alone (no fs call), or undefined. Runs on every platform. */
export function lexicalRefusal(raw: string): string | undefined {
  if (raw.trim() === '') return EMPTY_WORDS;
  const bad = LEXICAL_WORDS(raw);
  if (raw.includes('\0')) return bad;
  // UNC (\\host\share, //host/x), \\?\ and \\.\ all start with two separators.
  if (/^[\\/]{2}/.test(raw)) return bad;
  // C:foo is "foo in the current folder of drive C".
  if (/^[a-z]:(?![\\/])/i.test(raw)) return bad;
  const segs = raw.split(/[\\/]/);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s === '.' || s === '..') continue;
    if (/~\d/.test(s)) return bad; // 8.3 short name
    // A colon past the drive is an alternate data stream (a.txt::$DATA) or a device (CON:).
    if (s.includes(':') && !(i === 0 && /^[a-z]:$/i.test(s))) return bad;
    // Windows drops trailing dots and spaces, so "secrets.json." is "secrets.json".
    if (/[. ]$/.test(s)) return bad;
    if (DEVICE.test(s.split('.')[0]!.replace(/ +$/, ''))) return bad;
  }
  return undefined;
}

class Unresolved extends Error {}

/** The real path of `abs`, or of its nearest existing parent plus the rest. A link that leads nowhere, or any other fs trouble, is Unresolved. */
function realOf(fs: FsLike, P: path.PlatformPath, abs: string): string {
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return rest.length ? P.join(fs.realpathSync.native(cur), ...rest.reverse()) : fs.realpathSync.native(cur);
    } catch (e) {
      if (!missing(e)) throw wrap(e);
    }
    // It does not resolve. A path that is simply not there climbs to its parent; one that is there (a dangling link) is refused.
    try {
      fs.lstatSync(cur);
      throw new Unresolved();
    } catch (e) {
      if (!missing(e)) throw wrap(e);
    }
    const parent = P.dirname(cur);
    if (parent === cur) throw new Unresolved();
    rest.push(P.basename(cur));
    cur = parent;
  }
}
const missing = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes((e as { code?: string })?.code ?? '');
// An fs error (it has a code) means "cannot tell"; anything else is a bug and goes up to the caller's fail-closed handler.
const wrap = (e: unknown) => (e instanceof Unresolved || typeof (e as { code?: unknown })?.code === 'string' ? new Unresolved() : e);

/** True when `child` is `parent` or below it. Case-insensitive where `ci`. Both are absolute and normalized by the same path module. */
function under(P: path.PlatformPath, ci: boolean, child: string, parent: string): boolean {
  const c = ci ? child.toLowerCase() : child;
  const p = ci ? parent.toLowerCase() : parent;
  return c === p || c.startsWith(p.endsWith(P.sep) ? p : p + P.sep);
}

/** `abs` relative to `root` with `/` separators; `.` for the root itself. */
export function toRel(abs: string, root: string, platform: NodeJS.Platform = process.platform): string {
  const P = platform === 'win32' ? path.win32 : path.posix;
  return P.relative(root, abs).split(P.sep).join('/') || '.';
}

export function confine(raw: string, ctx: ConfineCtx): Confined {
  const platform = ctx.platform ?? process.platform;
  const fs = ctx.fs ?? nodeFs;
  const P = platform === 'win32' ? path.win32 : path.posix;
  // Windows and macOS filesystems ignore case (policy.ts relPath does the same).
  const ci = platform === 'win32' || platform === 'darwin';
  const bad = lexicalRefusal(raw);
  if (bad) return { ok: false, reason: bad };
  try {
    const root = realOf(fs, P, P.resolve(ctx.cwd));
    const lexHome = P.resolve(ctx.home);
    const homes = new Set([lexHome, realOf(fs, P, lexHome)]);
    // Before any component is followed: a name that lies under the home as written (or as the cwd spells it) is refused, so a link inside the
    // home that leads back into the project cannot make it allowed.
    for (const named of new Set([P.resolve(root, raw), P.resolve(ctx.cwd, raw)])) {
      for (const home of homes) if (under(P, ci, named, home)) return { ok: false, reason: HOME_WORDS };
    }
    // Resolved against the real cwd, then the real path of the result. The tool is given this path, never the raw one.
    // ponytail: a folder on the way swapped for a link after this check and before the tool opens the file is not seen (Node has no open anchored
    // to a folder); closing it needs a native helper. Case is folded for the whole OS (win32, darwin), so `proj` and `PROJ` are one folder here even
    // on a case-sensitive volume (a manual platform check); the binary check of the tools looks at the first 8 KB only.
    const abs = realOf(fs, P, P.resolve(root, raw));
    for (const home of homes) if (under(P, ci, abs, home)) return { ok: false, reason: HOME_WORDS };
    return { ok: true, abs, inside: under(P, ci, abs, root), root };
  } catch (e) {
    if (e instanceof Unresolved) return { ok: false, reason: UNRESOLVED_WORDS(raw) };
    throw e;
  }
}

export const MAX_DEPTH = 20;
const SKIP = new Set(['node_modules', '.git']);

/**
 * The files below `root`, in name order, without following any link (lstat), to depth 20 (a path of at most 20 segments below root),
 * skipping node_modules and .git. A link, a junction, a socket or a device is not listed and not entered.
 */
export const MAX_ENTRIES = 200_000;

/** Lets the event loop run (an interrupt, other sessions) when the work has held it for a while. */
export function yielder() {
  let last = Date.now();
  return async () => {
    if (Date.now() - last > 10) {
      await new Promise((r) => setImmediate(r));
      last = Date.now();
    }
  };
}

export interface WalkOpts {
  /** Asked before a folder is read (the root too): false and the folder is never entered. */
  allowDir?(abs: string): boolean;
  signal?: AbortSignal;
  /** Entries (files and folders) looked at before the walk stops. */
  maxEntries?: number;
  /** The time (by `now`) after which the walk stops. */
  deadline?: number;
  now?: () => number;
  /** Set to 'entries' when the walk stopped because it looked at too many, to 'deadline' when time ran out. */
  state?: { stopped?: 'entries' | 'deadline' };
}

/**
 * The files below `root`, in name order, as an async walk: it gives the event loop a turn now and then, and stops at once when the signal is
 * aborted or after `maxEntries` entries, folders without files included. Without following any link (lstat), to depth 20 (a path of at most 20
 * segments below root), skipping node_modules and .git in any case. A link, a junction, a socket or a device is not listed and not entered.
 */
export async function* walkFiles(root: string, o: WalkOpts = {}, fs: Pick<typeof nodeFs, 'readdirSync' | 'lstatSync'> = nodeFs): AsyncGenerator<string> {
  const tick = yielder();
  const max = o.maxEntries ?? MAX_ENTRIES;
  let seen = 0;
  let stop = false;
  async function* go(dir: string, depth: number): AsyncGenerator<string> {
    if (o.allowDir && !o.allowDir(dir)) return;
    let names: string[];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (stop || o.signal?.aborted) return;
      if (++seen > max) {
        stop = true;
        if (o.state) o.state.stopped = 'entries';
        return;
      }
      if (o.deadline !== undefined && (o.now ?? Date.now)() > o.deadline) {
        stop = true;
        if (o.state) o.state.stopped = 'deadline';
        return;
      }
      await tick();
      if (SKIP.has(n.toLowerCase())) continue;
      const p = path.join(dir, n);
      let st: Stats;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (depth < MAX_DEPTH) yield* go(p, depth + 1);
      } else if (st.isFile()) yield p;
    }
  }
  yield* go(root, 1);
}
