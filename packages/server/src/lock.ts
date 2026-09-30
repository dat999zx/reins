import { randomBytes } from 'node:crypto';
import fs from 'node:fs';

export interface LockInfo { pid: number; port: number; token: string }

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/**
 * The one running `reins serve` (plan 15d 3b.3): the file holds its pid, port and token. A dead pid's lock is replaced.
 * The file is written whole under a temp name and then hard-linked into place, so a second instance never reads a
 * half-written lock and `linkSync` fails with EEXIST for exactly one of two racing instances.
 * ponytail: two instances taking over the SAME stale lock in the same microseconds can still both win, and a dead
 * server's pid reused by another process keeps the lock until it is deleted by hand. An OS file lock closes both.
 */
export function takeLock(file: string, info: LockInfo, alive: (pid: number) => boolean = pidAlive): { ok: true } | { ok: false; running: LockInfo } {
  const tmp = `${file}.${info.pid}.${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.linkSync(tmp, file);
        return { ok: true };
      } catch (e: any) {
        if (e?.code !== 'EEXIST') throw e;
      }
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        continue; // released between the link and the read
      }
      let held: LockInfo | undefined;
      try {
        held = JSON.parse(raw);
      } catch {
        held = undefined; // never a half-written lock (see above), so a corrupt file is stale
      }
      if (held && alive(held.pid)) return { ok: false, running: held };
      if (fs.readFileSync(file, 'utf8') === raw) fs.rmSync(file, { force: true }); // only the lock we judged stale
    }
    throw new Error(`cannot take ${file}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function releaseLock(file: string, pid: number): void {
  try {
    if ((JSON.parse(fs.readFileSync(file, 'utf8')) as LockInfo).pid === pid) fs.rmSync(file, { force: true });
  } catch {
    // no lock, or not ours to remove
  }
}
