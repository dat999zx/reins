// The conversation file of one loop session (spec 4.6, 8.3): `<home>/conversations/<sessionId>.jsonl`, one JSON line per message. A reply and its
// spend are ONE line (`usage` inside the assistant line), so a crash cannot leave a paid reply with no record of it.
// It holds everything the agent read, so: the session id is checked before it is part of a path, every value is redacted before it is written
// (and the line is checked once more), a file read back is checked line by line, never trusted, and one session at a time owns it (a lock file).
import nodeFs from 'node:fs';
import path from 'node:path';
import { pairUp } from './pairs.js';
import type { Block, Extra, Msg } from './types.js';

/** The fs calls the store makes. Tests pass a spy or one that fails. */
export type StoreFs = Pick<typeof nodeFs, 'mkdirSync' | 'lstatSync' | 'appendFileSync' | 'openSync' | 'fstatSync' | 'readSync' | 'closeSync' | 'writeSync' | 'readFileSync' | 'unlinkSync' | 'chmodSync'>;

/**
 * A session id Reins made (a UUID passes). Nothing else is ever put in a path. Lower case only: on a volume that ignores case `ABCDEFGH` and
 * `abcdefgh` are one file, and Reins makes lower case ids.
 */
export const ID_RULE = /^[a-z0-9_-]{8,64}$/;
export const BAD_ID = 'That session id is not one Reins made.';
export const BUSY = 'This conversation is open in another Reins session.';
// ponytail: a file over this is refused, not read. Compaction (Task 16) keeps files small. Loading holds the file's bytes and, one line at a
// time, its text and parsed form: about twice the file size at the peak. Streaming the lines would need an async parse; not worth it under this cap.
export const MAX_FILE = 256 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const NOFOLLOW = nodeFs.constants.O_NOFOLLOW ?? 0;
// ponytail: on Windows the mode is advisory (Node maps it to the read-only bit only) and there is no O_NOFOLLOW; the lstat before each write is
// what refuses a link there. On POSIX the file is 0600, the folder 0700, and the open itself refuses a link as the LAST part of the path.
export const APPEND_MODE = 0o600;
export const APPEND_FLAGS = nodeFs.constants.O_APPEND | nodeFs.constants.O_CREAT | nodeFs.constants.O_WRONLY | NOFOLLOW;
export const DIR_MODE = 0o700;
const LOCK_FLAGS = nodeFs.constants.O_WRONLY | nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | NOFOLLOW;

/** Bounds of accounting read from a file: a token count is a whole number up to 1e12, the cost of one call is up to 1e6 USD. Anything else is damage. */
export const COUNTER_MAX = 1e12;
export const COST_MAX = 1e6;

export interface UsageLine {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  /** USD of this call; none when the price was not known. */
  cost?: number;
}

export interface Loaded {
  msgs: Msg[];
  /**
   * Sum of the cost of every reply in the file; undefined (unknown, never 0) when any reply has no usage or no cost, when any line was
   * skipped (a paid reply may have been in it), or when a sum is not a finite number.
   */
  total: number | undefined;
  /** The same per model; a model with any call without a cost is left out, and none is given when the total is unknown for any other reason. */
  totals: Record<string, number>;
  /** The protocol of the last assistant line. */
  protocol?: string;
  /** Lines that were torn, did not parse, did not decode, held bad accounting, or were not a line Reins writes. */
  skipped: number;
}

export interface Conversation {
  readonly path: string;
  /** Takes the lock of this conversation for the life of the session (once); refuses when another session holds it. Released by `release`. */
  lock(): void;
  release(): void;
  /**
   * Reads the file (it must be there). `protocol` is the wire's now: thinking blocks and every `extra` of a line written on another one are dropped.
   * So are they for a line written by another PROVIDER (`Opts.provider`, recorded on every assistant line): the proofs and private fields of one
   * provider are sent to that provider only. A line with no provider recorded (an older file) is kept as before.
   */
  load(protocol: string): Loaded;
  /** A call that may have been paid and left no reply (it failed after the provider began to answer): a usage line with no cost, so the total of the file is unknown. */
  appendUnknownSpend(model: string): void;
  /** Appends one line (a reply carries its usage). Throws once on the first failure; after that it does nothing (`failed`). */
  appendMsg(msg: Msg, protocol: string, usage?: UsageLine): void;
  /**
   * Appends the boundary of a compaction: a user line whose FIRST block (a text) is written as the `summary` block, then the rest of the message.
   * A file loads from its last boundary. `usage` is the summary call's spend, on the same line, so a crash cannot leave a paid summary unrecorded.
   */
  appendSummary(msg: Msg, protocol: string, usage?: UsageLine): void;
  readonly failed: boolean;
}

interface Opts {
  fs?: StoreFs;
  /** The id of the provider this session talks to: written on every assistant line, and what a line is compared with when the file is read. */
  provider?: string;
  /** The host's whole-text redaction; none writes as it is. */
  redactAll?: (t: string) => string;
  /** The host's check that a text holds a known secret. */
  holdsSecret?: (t: string) => boolean;
  /** The user id of this process, for the ownership check of a folder or file that was already there; none (Windows) skips the check. */
  getuid?: () => number | undefined;
  /** Whether a process is alive (a stale lock is taken over). */
  alive?: (pid: number) => boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isCounter = (v: unknown): v is number => isNum(v) && Number.isInteger(v) && v >= 0 && v <= COUNTER_MAX;
const code = (e: unknown) => (e as { code?: string })?.code;

const defaultAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return code(e) === 'EPERM'; // it exists, we may not signal it
  }
};

// Lock files this process holds, by conversation file: the quick same-process check, and what is removed when the process exits.
const held = new Map<string, { lockFile: string; fs: StoreFs }>();
let exitHook = false;
const dropHeld = () => {
  for (const l of held.values()) {
    try {
      l.fs.unlinkSync(l.lockFile);
    } catch {
      /* nothing more to do at exit */
    }
  }
};

/** The file and its folder for an id, worked out with no fs call. */
export function locate(home: string, id: string): { dir: string; file: string; lockFile: string } {
  if (!isStr(id) || !ID_RULE.test(id)) throw new Error(BAD_ID);
  const dir = path.join(home, 'conversations');
  const file = path.join(dir, `${id}.jsonl`);
  // The id rule already allows no separator or dot; this is the second lock in case the rule is ever loosened: the file is directly in the folder.
  if (path.relative(dir, file) !== `${id}.jsonl`) throw new Error(BAD_ID);
  return { dir, file, lockFile: path.join(dir, `${id}.lock`) };
}

/** The same value with every string, and every key, redacted. */
const hide = (v: unknown, f: (t: string) => string): unknown =>
  isStr(v) ? f(v)
    : Array.isArray(v) ? v.map((x) => hide(x, f))
      : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [f(k), hide(x, f)]))
        : v;

const toFile = (b: Block): Obj => {
  switch (b.type) {
    case 'thinking': return { type: 'reasoning', text: b.text, ...(b.signature !== undefined ? { signature: b.signature } : {}), ...(b.extra ? { extra: b.extra } : {}) };
    case 'tool_call': return { type: 'tool_call', id: b.id, name: b.name, args: b.args, ...(b.extra ? { extra: b.extra } : {}) };
    case 'tool_result': return { type: 'tool_result', id: b.id, content: b.content, ...(b.isError ? { isError: true } : {}) };
    default: return { type: 'text', text: b.text };
  }
};

/** A block of a line, or undefined when it is not one Reins writes. A `summary` comes back as itself, for the caller to see the boundary. */
function fromFile(b: unknown): Block | { type: 'summary'; text: string } | undefined {
  if (!isObj(b)) return undefined;
  const extra: { extra?: Extra } = isObj(b.extra) ? { extra: b.extra } : {};
  switch (b.type) {
    case 'text': return isStr(b.text) ? { type: 'text', text: b.text } : undefined;
    case 'summary': return isStr(b.text) ? { type: 'summary', text: b.text } : undefined;
    case 'reasoning': return isStr(b.text) ? { type: 'thinking', text: b.text, ...(isStr(b.signature) ? { signature: b.signature } : {}), ...extra } : undefined;
    case 'tool_call': return isStr(b.id) && isStr(b.name) ? { type: 'tool_call', id: b.id, name: b.name, args: 'args' in b ? b.args : {}, ...extra } : undefined;
    case 'tool_result': return isStr(b.id) && isStr(b.content) ? { type: 'tool_result', id: b.id, content: b.content, ...(b.isError === true ? { isError: true } : {}) } : undefined;
    default: return undefined;
  }
}

/** Accounting of one call as a file gives it: undefined when it is not a well formed one (a damaged line). */
function usageFrom(v: unknown): UsageLine | undefined {
  if (!isObj(v) || !isStr(v.model)) return undefined;
  if (![v.input, v.output, v.cacheRead, v.cacheWrite].every(isCounter)) return undefined;
  if (v.reasoning !== undefined && !isCounter(v.reasoning)) return undefined;
  if (v.cost !== undefined && !(isNum(v.cost) && v.cost >= 0 && v.cost <= COST_MAX)) return undefined;
  return { model: v.model, input: v.input as number, output: v.output as number, cacheRead: v.cacheRead as number, cacheWrite: v.cacheWrite as number, ...(v.reasoning !== undefined ? { reasoning: v.reasoning as number } : {}), ...(v.cost !== undefined ? { cost: v.cost as number } : {}) };
}

const usageOut = (u: UsageLine): UsageLine => ({
  model: u.model, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
  ...(u.reasoning !== undefined ? { reasoning: u.reasoning } : {}), ...(u.cost !== undefined ? { cost: u.cost } : {}),
});

export function openConversation(home: string, id: string, o: Opts = {}): Conversation {
  const { dir, file, lockFile } = locate(home, id);
  const fs = o.fs ?? nodeFs;
  const redactAll = o.redactAll ?? ((t: string) => t);
  const uid = o.getuid ?? (() => process.getuid?.());
  const alive = o.alive ?? defaultAlive;
  let failed = false;
  let locked = false;
  // A file that ends in a torn line: the next line must start on its own line.
  let needsBreak = false;

  const lstat = (p: string) => {
    try {
      return fs.lstatSync(p);
    } catch (e) {
      if (code(e) === 'ENOENT') return undefined;
      throw e;
    }
  };
  /** A folder or file that was already there: ours (POSIX), and no wider than `mode`; tightened when it is ours and wider. */
  const private_ = (p: string, st: { uid: number; mode: number }, mode: number, what: string) => {
    const me = uid();
    if (me === undefined) return; // Windows: no owner or mode to check here (ACLs are not read)
    if (st.uid !== me) throw new Error(`The conversation ${what} belongs to another user, so Reins will not use it.`);
    if ((st.mode & 0o777 & ~mode) !== 0) fs.chmodSync(p, mode);
  };
  /**
   * Refuses a link, a folder that is not a folder, a file that is not a plain file, and (POSIX) one owned by another user; tightens ours.
   * What this holds: the checks run before every read and write, and on POSIX the open itself refuses a link as the last part of the path. A
   * folder swapped for a link between the check and the open needs another actor with write access to the Reins home: out of scope.
   * `make` creates the folder.
   */
  const checkPlace = (make: boolean): void => {
    let d = lstat(dir);
    if (!d && make) {
      fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      d = lstat(dir);
    }
    if (d) {
      if (d.isSymbolicLink()) throw new Error('The conversation folder is a link, so Reins will not use it.');
      if (!d.isDirectory()) throw new Error('The conversation folder is not a folder, so Reins will not use it.');
      private_(dir, d, DIR_MODE, 'folder');
    }
    const f = d ? lstat(file) : undefined;
    if (f) {
      if (f.isSymbolicLink()) throw new Error('The conversation file is a link, so Reins will not use it.');
      if (!f.isFile()) throw new Error('The conversation file is not a plain file, so Reins will not use it.');
      private_(file, f, APPEND_MODE, 'file');
    }
  };

  /** Whether the process named in the lock file is still there. Unreadable or garbage: no. */
  const ownerAlive = (): boolean => {
    try {
      const v: unknown = JSON.parse(String(fs.readFileSync(lockFile, 'utf8')));
      const pid = isObj(v) ? v.pid : undefined;
      return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid);
    } catch {
      return false;
    }
  };

  function write(v: Obj): void {
    if (failed) return;
    try {
      const line = JSON.stringify(hide(v, redactAll));
      // A known secret that is still there after the redaction (a split or encoded form the redaction does not know): the line is not written.
      if (o.holdsSecret?.(line)) throw new Error('a line still held a key after it was hidden, so it was not saved');
      checkPlace(true);
      // Opened here, with the flags and the mode, so the mode of a new file is ours and a link is refused by the open itself (POSIX).
      const fd = fs.openSync(file, APPEND_FLAGS, APPEND_MODE);
      try {
        fs.appendFileSync(fd, `${needsBreak ? '\n' : ''}${line}\n`);
      } finally {
        fs.closeSync(fd);
      }
      needsBreak = false;
    } catch (e) {
      failed = true;
      throw e;
    }
  }

  function readAll(): Buffer {
    const gone = () => new Error(`The conversation of this session is gone (${file}); start a new session.`);
    checkPlace(false);
    const st = lstat(file);
    if (!st) throw gone();
    if (st.size > MAX_FILE) throw new Error(`The conversation of this session is too big to open (over ${MAX_FILE / 1024 / 1024} MiB); start a new session.`);
    let fd: number;
    try {
      fd = fs.openSync(file, nodeFs.constants.O_RDONLY | NOFOLLOW);
    } catch (e) {
      if (code(e) === 'ENOENT') throw gone();
      throw e;
    }
    try {
      const now = fs.fstatSync(fd);
      if (!now.isFile()) throw new Error('The conversation file is not a plain file, so Reins will not use it.');
      // Bounded by what is read, not by the size seen before: a file that grows while it is read is still refused at the limit.
      const chunks: Buffer[] = [];
      let total = 0;
      while (total <= MAX_FILE) {
        const buf = Buffer.allocUnsafe(Math.min(CHUNK, MAX_FILE + 1 - total));
        const n = fs.readSync(fd, buf, 0, buf.length, total);
        if (!n) break;
        chunks.push(buf.subarray(0, n));
        total += n;
      }
      if (total > MAX_FILE) throw new Error(`The conversation of this session is too big to open (over ${MAX_FILE / 1024 / 1024} MiB); start a new session.`);
      return Buffer.concat(chunks);
    } finally {
      fs.closeSync(fd);
    }
  }

  return {
    path: file,
    get failed() {
      return failed;
    },
    lock() {
      if (locked) return;
      if (held.has(file)) throw new Error(BUSY);
      checkPlace(true);
      for (let tries = 0; ; tries++) {
        try {
          const fd = fs.openSync(lockFile, LOCK_FLAGS, 0o600);
          try {
            fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
          } finally {
            fs.closeSync(fd);
          }
          break;
        } catch (e) {
          if (code(e) !== 'EEXIST') throw e;
          // Held by a live process: refused. A dead one, or a file that says nothing: taken over (once; a second collision is a live race).
          if (tries >= 1 || ownerAlive()) throw new Error(BUSY);
          try {
            fs.unlinkSync(lockFile);
          } catch (u) {
            if (code(u) !== 'ENOENT') throw u;
          }
        }
      }
      held.set(file, { lockFile, fs });
      locked = true;
      if (!exitHook) {
        exitHook = true;
        process.once('exit', dropHeld);
      }
    },
    release() {
      if (!locked) return;
      locked = false;
      held.delete(file);
      try {
        fs.unlinkSync(lockFile);
      } catch {
        /* already gone */
      }
    },
    load(protocol) {
      let bytes: Buffer;
      try {
        bytes = readAll();
      } catch (e) {
        // Our own words go up as they are; an fs failure gets a plain sentence with its reason (redacted).
        if (code(e) === undefined) throw e;
        throw new Error(`Could not read the conversation of this session (${redactAll((e as Error).message)}).`);
      }
      needsBreak = bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a;
      let msgs: Msg[] = [];
      let skipped = 0;
      let last: string | undefined;
      // Accounting over EVERY line of the file, including what a summary boundary drops: the money was spent.
      let unknown = false;
      let spent = 0;
      let replies = 0; // assistant lines
      let inline = 0; // of them, with usage inside
      let separate = 0; // old format: usage lines of their own
      const byModel = new Map<string, number | undefined>();
      const account = (u: UsageLine) => {
        const was = byModel.has(u.model) ? byModel.get(u.model) : 0;
        if (u.cost === undefined) {
          unknown = true;
          byModel.set(u.model, undefined);
          return;
        }
        spent += u.cost;
        const sum = was === undefined ? undefined : was + u.cost;
        byModel.set(u.model, sum !== undefined && Number.isFinite(sum) ? sum : undefined);
        if (!Number.isFinite(spent)) unknown = true;
      };
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      // One leading UTF-8 byte order mark is not part of the first line.
      let at = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
      while (at < bytes.length) {
        let end = bytes.indexOf(0x0a, at);
        if (end < 0) end = bytes.length;
        const slice = bytes.subarray(at, end);
        at = end + 1;
        let text: string;
        try {
          text = decoder.decode(slice);
        } catch {
          skipped++; // not UTF-8: damaged
          continue;
        }
        if (text.trim() === '') continue;
        let line: unknown;
        try {
          line = JSON.parse(text);
        } catch {
          skipped++; // a torn last line, or a damaged one
          continue;
        }
        if (isObj(line) && line.t === 'usage') {
          // The old format: a call's usage on a line of its own.
          const u = usageFrom(line);
          if (!u) {
            skipped++;
            continue;
          }
          separate++;
          account(u);
          continue;
        }
        if (!isObj(line) || line.t !== 'msg' || (line.role !== 'user' && line.role !== 'assistant') || !Array.isArray(line.blocks)) {
          skipped++;
          continue;
        }
        const usage = line.usage === undefined ? undefined : usageFrom(line.usage);
        if (line.usage !== undefined && !usage) {
          skipped++;
          continue;
        }
        const blocks = line.blocks.map(fromFile);
        if (blocks.some((b) => b === undefined)) {
          skipped++;
          continue;
        }
        const role = line.role;
        if (role === 'assistant') replies++;
        // A user line may carry usage too: the summary call of a compaction, on its boundary line.
        if (usage) {
          if (role === 'assistant') inline++;
          account(usage);
        }
        const mapped: Block[] = [];
        let boundary = false;
        for (const b of blocks as Array<Block | { type: 'summary'; text: string }>) {
          if (b.type === 'summary') {
            boundary = true;
            mapped.push({ type: 'text', text: b.text });
          } else mapped.push(b);
        }
        // The last summary is where the conversation starts again (a compaction writes it).
        if (boundary) msgs = [];
        const lineProtocol = isStr(line.protocol) ? line.protocol : undefined;
        const lineProvider = isStr(line.provider) ? line.provider : undefined;
        if (role === 'assistant') last = lineProtocol;
        if (role === 'assistant' && (lineProtocol !== protocol || (o.provider !== undefined && lineProvider !== undefined && lineProvider !== o.provider))) {
          // Written for another protocol, or by another provider: its proofs and unknown fields mean nothing to this one (spec 4.6) and are not
          // its to read. They stay in the file, so the provider that wrote them gets them back when the session returns to it.
          msgs.push({ role, blocks: mapped.flatMap((b): Block[] => (b.type === 'thinking' ? [] : b.type === 'tool_call' ? [{ type: 'tool_call', id: b.id, name: b.name, args: b.args }] : [b])) });
        } else msgs.push({ role, blocks: mapped, ...(isObj(line.extra) ? { extra: line.extra } : {}) });
      }
      // A reply with no record of its spend is a reply that may have cost money: the total is unknown, not smaller. (Old files have their usage
      // on separate lines, so replies are covered when there are at least as many usage lines as replies without one inside.)
      const lost = skipped > 0 || replies - inline > separate;
      const totals: Record<string, number> = {};
      if (!lost) for (const [m, v] of byModel) if (v !== undefined) totals[m] = v;
      return { msgs: pairUp(msgs).msgs, total: lost || unknown ? undefined : spent, totals, ...(last !== undefined ? { protocol: last } : {}), skipped };
    },
    appendMsg(msg, protocol, usage) {
      write({
        t: 'msg', role: msg.role, blocks: msg.blocks.map(toFile),
        ...(msg.role === 'assistant' ? { protocol, ...(o.provider !== undefined ? { provider: o.provider } : {}) } : {}),
        ...(msg.extra ? { extra: msg.extra } : {}),
        ...(usage ? { usage: usageOut(usage) } : {}),
      });
    },
    appendUnknownSpend(model) {
      write({ t: 'usage', model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    },
    appendSummary(msg, protocol, usage) {
      const [first, ...rest] = msg.blocks;
      if (msg.role !== 'user' || first?.type !== 'text') throw new Error('a summary boundary is a user message that starts with text');
      write({
        t: 'msg', role: 'user', blocks: [{ type: 'summary', text: first.text }, ...rest.map(toFile)],
        ...(msg.extra ? { extra: msg.extra } : {}),
        ...(usage ? { usage: usageOut(usage) } : {}),
      });
    },
  };
}
