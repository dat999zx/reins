// File I/O of the loop's tools: reads bounded by the bytes actually read from an open handle (never by an earlier stat), the check for a
// hard link to a file of the Reins home, and the atomic replace that Write and Edit use.
import { randomBytes } from 'node:crypto';
import fs, { type BigIntStats } from 'node:fs';
import path from 'node:path';

const CHUNK = 1024 * 1024;

export interface Bounded {
  st: BigIntStats;
  /** At most `max + 1` bytes. */
  buf: Buffer;
  /** More than `max` bytes were there. */
  over: boolean;
}

const done = (st: BigIntStats, chunks: Buffer[], max: number): Bounded => {
  const buf = Buffer.concat(chunks);
  return { st, buf, over: buf.length > max };
};

/** Reads up to `max + 1` bytes from the opened file, in chunks, looking at the signal between them. 'notfile' when the handle is not a regular file. */
export async function readBounded(abs: string, max: number, signal?: AbortSignal): Promise<Bounded | 'aborted' | 'notfile'> {
  const fh = await fs.promises.open(abs, 'r');
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile()) return 'notfile';
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= max) {
      if (signal?.aborted) return 'aborted';
      const want = Math.min(CHUNK, max + 1 - total);
      const b = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(b, 0, want, total);
      if (!bytesRead) break;
      chunks.push(b.subarray(0, bytesRead));
      total += bytesRead;
    }
    return done(st, chunks, max);
  } finally {
    await fh.close();
  }
}

/**
 * The same, synchronous (Edit must read and write with no await between; Grep reads file after file). `stop` is asked between chunks:
 * true ends the read with 'stopped' (a deadline).
 */
export function readBoundedSync(abs: string, max: number, stop?: () => boolean): Bounded | 'notfile' | 'stopped' {
  const fd = fs.openSync(abs, 'r');
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile()) return 'notfile';
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= max) {
      if (stop?.()) return 'stopped';
      const want = Math.min(CHUNK, max + 1 - total);
      const b = Buffer.allocUnsafe(want);
      const n = fs.readSync(fd, b, 0, want, total);
      if (!n) break;
      chunks.push(b.subarray(0, n));
      total += n;
    }
    return done(st, chunks, max);
  } finally {
    fs.closeSync(fd);
  }
}

export const HOME_ENTRIES = 20_000;
export const HOME_MS = 500;
export const HOME_UNKNOWN_WORDS = 'Blocked by Reins: Reins could not check whether this file is a second name of a file of Reins itself.';

const idOf = (st: { dev: bigint; ino: bigint }) => `${st.dev}:${st.ino}`;

/**
 * Every regular file below the Reins home, as `dev:ino`, found without following any link, within HOME_ENTRIES entries and HOME_MS.
 * `failed` is true when the walk could not be completed (a folder that cannot be listed, a limit, any error): then nothing can be said.
 */
export function scanHome(home: string): { ids: Set<string>; failed: boolean } {
  const ids = new Set<string>();
  const began = Date.now();
  let seen = 0;
  try {
    const roots = new Set([home]);
    try {
      roots.add(fs.realpathSync.native(home));
    } catch (e) {
      if ((e as { code?: string }).code !== 'ENOENT') throw e;
    }
    for (const root of roots) {
      const todo = [root];
      while (todo.length) {
        const dir = todo.pop()!;
        let names: string[];
        try {
          names = fs.readdirSync(dir);
        } catch (e) {
          // A home (or a folder) that is not there holds no files; any other trouble means we cannot tell.
          if ((e as { code?: string }).code === 'ENOENT') continue;
          return { ids, failed: true };
        }
        for (const n of names) {
          if (++seen > HOME_ENTRIES || Date.now() - began > HOME_MS) return { ids, failed: true };
          const p = path.join(dir, n);
          let st: BigIntStats;
          try {
            st = fs.lstatSync(p, { bigint: true });
          } catch (e) {
            if ((e as { code?: string }).code === 'ENOENT') continue; // gone since the listing
            return { ids, failed: true };
          }
          if (st.isFile()) ids.add(idOf(st));
          else if (st.isDirectory()) todo.push(p);
        }
      }
    }
    return { ids, failed: false };
  } catch {
    return { ids, failed: true };
  }
}

/**
 * Whether an opened file is another name of a file of the Reins home. `'ok'` for a file with one name (the home is not even looked at),
 * `'home'` for a second name of a home file, `'unknown'` when the home could not be checked (refuse). The home is scanned at most once per guard,
 * so one guard per tool call serves a Grep over many files. Only a file with more than one name can be affected; a hard-linked file
 * elsewhere (a package store) passes.
 */
export function homeGuard(home: string, scan: (home: string) => { ids: Set<string>; failed: boolean } = scanHome) {
  let found: { ids: Set<string>; failed: boolean } | undefined;
  return (st: BigIntStats): 'ok' | 'home' | 'unknown' => {
    if (st.nlink <= 1n) return 'ok';
    found ??= scan(home);
    if (found.ids.has(idOf(st))) return 'home';
    return found.failed ? 'unknown' : 'ok';
  };
}

// Read once, at load: the process mask cannot be read without being set on some systems, and it does not change while Reins runs.
const UMASK = process.umask();

/**
 * Replaces the file at `abs` with `content` in one step: the new content goes to an exclusive temporary file in the same folder, created 0600 (it
 * may hold private data), then takes the mode of the file it replaces (a new file gets 0666 minus the umask), is flushed and closed, and is renamed
 * over it. A hard-linked alias keeps the old content, a failure of any step (a mode that cannot be set included) leaves the old file whole and the
 * temporary file removed, and only a temporary file this call created is ever removed. Synchronous.
 * ponytail: Windows keeps no ACL through the replace (Node cannot read or set one); the mode maps to the read-only bit only.
 */
export function replaceFile(abs: string, content: string): void {
  let mode: number | undefined;
  try {
    mode = fs.lstatSync(abs).mode & 0o7777;
  } catch {
    /* a new file */
  }
  const dir = path.dirname(abs);
  let tmp = '';
  let fd: number | undefined;
  for (let tries = 0; fd === undefined; tries++) {
    tmp = path.join(dir, `.reins-${randomBytes(12).toString('hex')}.tmp`);
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
    } catch (e) {
      // The name is taken by something else: not ours to touch. Another name, a few times.
      if ((e as { code?: string }).code !== 'EEXIST' || tries >= 4) throw e;
    }
  }
  try {
    const data = Buffer.from(content, 'utf8');
    for (let at = 0; at < data.length; ) at += fs.writeSync(fd, data, at);
    fs.fchmodSync(fd, mode ?? 0o666 & ~UMASK);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, abs);
  } catch (e) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing more to do */
    }
    throw e;
  }
}
