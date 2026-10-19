// The loop's tool table (spec 4.2): the usual coding-agent names and inputs, as data. The engine looks a tool up here and never switches on a name.
// Every path a file tool touches is confined first (paths.ts); `run` is given the confined path.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import picomatch from 'picomatch';
import type { Policy } from '@reins/core';
import { HOME_UNKNOWN_WORDS, homeGuard, readBounded, readBoundedSync, replaceFile, type Bounded } from './fileio.js';
import { confine, HOME_WORDS, toRel, walkFiles, type FsLike } from './paths.js';
import { HOME_NAMED_WORDS, namesHome, runShell } from './shell.js';
import type { ToolSpec } from './types.js';

export type ToolClass = 'read' | 'write' | 'shell';

export interface ToolCtx {
  cwd: string;
  home: string;
  policy: () => Policy;
  signal: AbortSignal;
  /** The host's sanitizer; with `max` the result is cut after redacting without ending on the start of a key. */
  redact: (text: string, max?: number) => string;
  /** Redacts a whole text: no trim of an ending that could be the start of a key. */
  redactAll: (text: string) => string;
  platform: NodeJS.Platform;
  /** Works out the key-free env a shell command gets, once per command (the host's `shellEnv`). Undefined: the shell refuses to run. */
  env?: (() => NodeJS.ProcessEnv) | undefined;
  /** A new redactor for one output stream (the host's `redactStream`). Undefined: the shell refuses to run. */
  redactStream?: (() => { push(text: string): string; end(): string }) | undefined;
  fs?: FsLike;
  /** Entries a Glob or Grep looks at before it stops (tests lower it). */
  maxEntries?: number;
  /** The clock of the one deadline of a Glob or Grep call (tests move it). */
  now?: () => number;
}

/** What `confine` decided: the real path the tool opens, and the real cwd that relative paths are shown against. */
export interface Target {
  abs: string;
  root: string;
}

export interface ToolOut {
  text: string;
  isError?: boolean;
}

export interface Tool {
  name: string;
  class: ToolClass;
  description: string;
  /** A JSON Schema object. The engine checks the input against `properties` and `required` before anything else. */
  schema: { type: 'object'; properties: Record<string, Prop>; required: string[]; additionalProperties: false };
  /** The input field that names the path the tool touches. `optional`: the cwd when it is missing. */
  path?: { arg: string; optional?: boolean };
  /** A refusal that needs only the input (and where the Reins home, the cwd and the platform are). */
  refuse?(input: Record<string, unknown>, ctx: { home: string; cwd: string; platform: NodeJS.Platform }): string | undefined;
  /** Absent for a tool that cannot run. */
  run?(input: Record<string, unknown>, ctx: ToolCtx, t: Target): ToolOut | Promise<ToolOut>;
}

interface Prop {
  type: 'string' | 'integer' | 'number' | 'boolean';
  description: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

export const RESULT_CAP = 100_000;
export const CUT_NOTE = '\n[output cut]';
export const READ_NOTE = '[output cut: use offset to read more]';
export const MAX_LINES = 2000;
export const MAX_PATHS = 500;
export const MAX_MATCHES = 500;
export const MAX_GREP_FILE = 2 * 1024 * 1024;
export const MAX_GREP_BYTES = 50 * 1024 * 1024;
// Read and Edit hold a whole file in memory; a bigger one is for Grep.
export const MAX_FILE = 20 * 1024 * 1024;
/** A line longer than this is not matched; one file may match for 2 s, one Grep call for 10 s. */
export const MAX_LINE = 10_000;
export const FILE_MS = 2000;
export const CALL_MS = 10_000;
const BINARY_PEEK = 8192;
const LINE_SHOWN = 500;
export const HARD_LINK_WORDS = 'Blocked by Reins: this file has other names (hard links), so Reins will not change it.';

const ok = (text: string): ToolOut => ({ text });
const fail = (text: string): ToolOut => ({ text, isError: true });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
// ponytail: only the first 8 KB is looked at, so a NUL later in a file is not seen; a full scan costs a pass over every file.
const isBinary = (buf: Buffer) => buf.subarray(0, BINARY_PEEK).includes(0);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const code = (e: unknown) => (e as { code?: string })?.code;

/**
 * `text` redacted whole, and at most `max` characters: when it is longer, it is cut after redacting (`redact(text, max)` never ends on the start
 * of a key) and `note` is added. The one place a result is cut and redacted (spec 8.3 choke point 3).
 */
export function cutText(redact: ToolCtx['redact'], redactAll: ToolCtx['redactAll'], text: string, max = RESULT_CAP, note = CUT_NOTE): string {
  const full = redactAll(text);
  return full.length <= max ? full : redact(text, Math.max(0, max - note.length)) + note;
}

// ---- file tools -------------------------------------------------------------------------------------------------------------------

const rel = (t: Target, ctx: ToolCtx, abs = t.abs) => toRel(abs, t.root, ctx.platform);
const notFound = (e: unknown, shown: string) => (code(e) === 'ENOENT' || code(e) === 'ENOTDIR' ? fail(`File not found: ${shown}`) : fail(`Cannot read ${shown}: ${errText(e)}`));
const overWords = (shown: string, what: string) => `${shown} is over ${MAX_FILE / 1024 / 1024} MB${what}`;

const read: Tool = {
  name: 'Read',
  class: 'read',
  description: 'Reads a text file and returns its lines numbered from 1. At most 2000 lines and 100000 characters per call; use offset and limit to read more.',
  schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The file to read: a path inside the project folder.' },
      offset: { type: 'integer', description: 'The line number to start at (from 1).', minimum: 1 },
      limit: { type: 'integer', description: 'How many lines to read.', minimum: 1 },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  path: { arg: 'file_path' },
  async run(input, ctx, t) {
    const shown = rel(t, ctx);
    let kind: fs.Stats;
    try {
      kind = await fs.promises.lstat(t.abs);
    } catch (e) {
      return notFound(e, shown);
    }
    if (kind.isDirectory()) return fail(`${shown} is a folder, not a file. Use Glob to list what is in it.`);
    if (!kind.isFile()) return fail(`${shown} is not a regular file, so Reins does not open it.`);
    // The bytes are counted as they are read from the open file, not taken from the size seen above: a file that grows is cut off, never loaded whole.
    let got: Awaited<ReturnType<typeof readBounded>>;
    try {
      got = await readBounded(t.abs, MAX_FILE, ctx.signal);
    } catch (e) {
      return notFound(e, shown);
    }
    if (got === 'aborted') return fail('Interrupted.');
    if (got === 'notfile') return fail(`${shown} is not a regular file, so Reins does not open it.`);
    if (got.over) return fail(overWords(shown, '. Use Grep to find what you need in it.'));
    const homed = homeGuard(ctx.home)(got.st);
    if (homed !== 'ok') return fail(homed === 'home' ? HOME_WORDS : HOME_UNKNOWN_WORDS);
    const buf = got.buf;
    if (isBinary(buf)) return fail(`${shown} looks like a binary file, so Read does not open it.`);
    const lines = buf.toString('utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (!lines.length) return ok(`${shown} is empty.`);
    const offset = (input.offset as number | undefined) ?? 1;
    if (offset > lines.length) return fail(`offset ${offset} is past the end of ${shown}, which has ${lines.length} lines.`);
    const end = Math.min(offset - 1 + Math.min((input.limit as number | undefined) ?? MAX_LINES, MAX_LINES), lines.length);
    const out: string[] = [];
    let size = 0;
    let at = offset - 1;
    // Collects a little more than the cap; cutText below does the exact, redaction-safe cut.
    for (; at < end && size <= RESULT_CAP; at++) {
      const line = `${String(at + 1).padStart(6)}\t${lines[at]!.replace(/\r$/, '')}`;
      out.push(line);
      size += line.length + 1;
    }
    const more = at < lines.length;
    return ok(cutText(ctx.redact, ctx.redactAll, out.join('\n') + (more ? `\n${READ_NOTE}` : ''), RESULT_CAP, `\n${READ_NOTE}`));
  },
};

const write: Tool = {
  name: 'Write',
  class: 'write',
  description: 'Writes a file inside the project folder, replacing it if it exists. Creates the folders it needs. To change part of a file, use Edit.',
  schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The file to write: a path inside the project folder.' },
      content: { type: 'string', description: 'The whole new content of the file.' },
    },
    required: ['file_path', 'content'],
    additionalProperties: false,
  },
  path: { arg: 'file_path' },
  run(input, ctx, t) {
    const shown = rel(t, ctx);
    if (Buffer.byteLength(input.content as string) > MAX_FILE) return fail(`The content is over ${MAX_FILE / 1024 / 1024} MB, too big to write.`);
    try {
      const st = (() => {
        try {
          return fs.lstatSync(t.abs);
        } catch {
          return undefined;
        }
      })();
      if (st && !st.isFile()) return fail(`${shown} exists and is not a file, so Write cannot replace it.`);
      if (st && st.nlink > 1) return fail(HARD_LINK_WORDS);
      fs.mkdirSync(path.dirname(t.abs), { recursive: true });
      replaceFile(t.abs, input.content as string);
      return ok(`Wrote ${Buffer.byteLength(input.content as string)} bytes to ${shown}`);
    } catch (e) {
      return fail(`Cannot write ${shown}: ${errText(e)}`);
    }
  },
};

const count = (text: string, find: string) => {
  let n = 0;
  for (let i = text.indexOf(find); i >= 0; i = text.indexOf(find, i + find.length)) n++;
  return n;
};

const edit: Tool = {
  name: 'Edit',
  class: 'write',
  description: 'Replaces text in an existing file. old_string must appear exactly once unless replace_all is true. Read the file first.',
  schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The file to edit: a path inside the project folder.' },
      old_string: { type: 'string', description: 'The text to replace. Must be unique in the file unless replace_all is true.' },
      new_string: { type: 'string', description: 'The text to put in its place.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string.' },
    },
    required: ['file_path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  path: { arg: 'file_path' },
  // Synchronous on purpose: the read and the write happen with no await between, so two sessions in one process never interleave a read-modify-write.
  run(input, ctx, t) {
    const shown = rel(t, ctx);
    let old = input.old_string as string;
    let now = input.new_string as string;
    if (old === '') return fail('old_string is empty. To make a new file use Write.');
    if (old === now) return fail('old_string and new_string are the same, so there is nothing to change.');
    try {
      const kind = fs.lstatSync(t.abs);
      if (kind.isDirectory()) return fail(`${shown} is a folder, not a file.`);
      if (!kind.isFile()) return fail(`${shown} is not a regular file, so Reins does not open it.`);
      const got = readBoundedSync(t.abs, MAX_FILE);
      if (got === 'notfile' || got === 'stopped') return fail(`${shown} is not a regular file, so Reins does not open it.`);
      if (got.over) return fail(overWords(shown, ', too big to edit.'));
      if (got.st.nlink > 1n) return fail(HARD_LINK_WORDS);
      const buf = got.buf;
      const text = buf.toString('utf8');
      // Text that does not survive a round trip through UTF-8 would be damaged by the write.
      if (isBinary(buf) || !Buffer.from(text, 'utf8').equals(buf)) return fail(`${shown} is not plain UTF-8 text, so Edit does not change it.`);
      // The model writes line breaks as \n. In a CRLF file the match may use CRLF, and the text put in always does; an LF file stays LF.
      const crlf = text.includes('\r\n');
      const toCrlf = (s: string) => s.replace(/\r?\n/g, '\r\n');
      let n = count(text, old);
      if (n === 0 && crlf) {
        n = count(text, toCrlf(old));
        if (n > 0) old = toCrlf(old);
      }
      if (crlf) now = toCrlf(now);
      if (n === 0) return fail(`old_string was not found in ${shown}. Read the file again and copy the text exactly.`);
      const all = input.replace_all === true;
      if (n > 1 && !all) return fail(`old_string was found ${n} times in ${shown}; add more context or set replace_all.`);
      // The size of the result is known before the result is built, so a replacement that blows a file up is refused, not allocated.
      const grown = buf.length + (all ? n : 1) * (Buffer.byteLength(now) - Buffer.byteLength(old));
      if (grown > MAX_FILE) return fail(`The result would be over ${MAX_FILE / 1024 / 1024} MB, too big to edit. Change less at once.`);
      // split/join, not replace(): a $ in new_string is text.
      const next = all ? text.split(old).join(now) : text.slice(0, text.indexOf(old)) + now + text.slice(text.indexOf(old) + old.length);
      replaceFile(t.abs, next);
      return ok(`Edited ${shown}: replaced ${all ? n : 1} ${(all ? n : 1) === 1 ? 'occurrence' : 'occurrences'}.`);
    } catch (e) {
      return notFound(e, shown);
    }
  },
};

// ---- search tools ------------------------------------------------------------------------------------------------------------------

const dotdot = (pattern: unknown) =>
  typeof pattern === 'string' && pattern.split(/[\\/]/).includes('..')
    ? `Blocked by Reins: a pattern may not have .. segments (${pattern.slice(0, 200)}).`
    : undefined;

const ci = (platform: NodeJS.Platform) => platform === 'win32' || platform === 'darwin';
// A model on Windows writes src\**\*.ts; picomatch would take the backslash for an escape.
const slashes = (p: string, platform: NodeJS.Platform) => (platform === 'win32' ? p.replace(/\\/g, '/') : p);

interface WalkState {
  stopped?: 'entries' | 'deadline';
  single?: boolean;
}

/** One deadline for a whole Glob or Grep call: the walk, the reads and the matching. */
const DEADLINE_WORDS = (tool: string) => `${tool} stopped: it ran longer than ${CALL_MS / 1000} s`;

/**
 * The files below the target that pass confinement, one by one (spec 4.3: every result, and every folder before it is read). Walks without
 * following links. Yields `[abs, path relative to the search root]`, in name order. A folder or a result outside the cwd, or in the Reins home,
 * is never entered or dropped.
 */
async function* results(ctx: ToolCtx, t: Target, state: WalkState, deadline: number): AsyncGenerator<[string, string]> {
  try {
    state.single = fs.lstatSync(t.abs).isFile();
  } catch {
    return;
  }
  const cf = { cwd: ctx.cwd, home: ctx.home, platform: ctx.platform, ...(ctx.fs ? { fs: ctx.fs } : {}) };
  const allowDir = (abs: string) => {
    const c = confine(toRel(abs, t.root, ctx.platform), cf);
    return c.ok && c.inside;
  };
  const files = state.single ? [t.abs] : walkFiles(t.abs, { allowDir, signal: ctx.signal, state, deadline, now: ctx.now ?? Date.now, ...(ctx.maxEntries ? { maxEntries: ctx.maxEntries } : {}) });
  for await (const abs of files) {
    if (ctx.signal.aborted) return;
    const c = confine(toRel(abs, t.root, ctx.platform), cf);
    if (c.ok && c.inside) yield [c.abs, state.single ? path.basename(abs) : toRel(abs, t.abs, ctx.platform)];
  }
}

const TOO_MANY = 'search stopped: too many entries';

const glob: Tool = {
  name: 'Glob',
  class: 'read',
  description: 'Lists files whose path matches a glob pattern such as src/**/*.ts. At most 500 paths, relative to the project folder. Does not follow links; skips node_modules and .git.',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The glob pattern, matched against paths below the search folder. No .. segments.' },
      path: { type: 'string', description: 'The folder to search (default: the project folder).' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  path: { arg: 'path', optional: true },
  refuse: (input) => dotdot(input.pattern),
  async run(input, ctx, t) {
    const match = picomatch(slashes(input.pattern as string, ctx.platform), { dot: true, nocase: ci(ctx.platform), windows: false });
    const found: string[] = [];
    const state: WalkState = {};
    const now = ctx.now ?? Date.now;
    const deadline = now() + CALL_MS;
    let cut = false;
    for await (const [abs, below] of results(ctx, t, state, deadline)) {
      if (!match(below)) continue;
      if (found.length >= MAX_PATHS) {
        cut = true;
        break;
      }
      found.push(toRel(abs, t.root, ctx.platform));
    }
    if (ctx.signal.aborted) return fail('Interrupted.');
    const notes = [...(cut ? [`[results cut at ${MAX_PATHS} paths]`] : []), ...(state.stopped === 'entries' ? [TOO_MANY] : []), ...(state.stopped === 'deadline' ? [DEADLINE_WORDS('Glob')] : [])];
    // A search that was stopped did not look everywhere: it never says that nothing was found.
    return ok([found.length ? found.join('\n') : state.stopped ? '' : 'No files found.', ...notes].filter((s) => s !== '').join('\n'));
  },
};

// Runs one file's lines against the pattern inside the engine's own time limit: a pattern that backtracks without end is stopped by `timeout`,
// which a check from outside `re.test()` could never do. Gives the numbers of the matching lines.
const MATCH = new vm.Script(
  '(function () { const out = []; for (let i = 0; i < lines.length; i++) { const l = lines[i]; if (l.length > max) continue; if (re.test(l)) { out.push(i); if (first) break; } } return out; })()',
);

const grep: Tool = {
  name: 'Grep',
  class: 'read',
  description:
    'Searches file contents with a JavaScript regular expression, line by line. At most 500 matches. Skips binary files, files over 2 MB, links, node_modules and .git. output_mode: content (default), files_with_matches or count.',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The regular expression (JavaScript syntax).' },
      path: { type: 'string', description: 'The file or folder to search (default: the project folder).' },
      glob: { type: 'string', description: 'Only search files whose path matches this glob, such as *.ts. No .. segments.' },
      '-i': { type: 'boolean', description: 'Ignore case.' },
      output_mode: { type: 'string', description: 'What to return.', enum: ['content', 'files_with_matches', 'count'] },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  path: { arg: 'path', optional: true },
  // `pattern` is a regular expression here, not a path; only the glob filter is.
  refuse: (input) => dotdot(input.glob),
  async run(input, ctx, t) {
    let re: RegExp;
    try {
      re = new RegExp(input.pattern as string, input['-i'] === true ? 'i' : '');
    } catch (e) {
      return fail(`The pattern is not a valid regular expression: ${errText(e)}`);
    }
    const mode = (input.output_mode as string | undefined) ?? 'content';
    const only = typeof input.glob === 'string' ? picomatch(slashes(input.glob, ctx.platform), { dot: true, nocase: ci(ctx.platform), windows: false, basename: true }) : undefined;
    const sandbox = vm.createContext({ lines: [] as string[], re, first: mode === 'files_with_matches', max: MAX_LINE });
    const out: string[] = [];
    const state: WalkState = {};
    const now = ctx.now ?? Date.now;
    // One deadline for the whole call: the walk, the reads and the matching all count against it.
    const deadline = now() + CALL_MS;
    let cut = false;
    let scanned = 0;
    let budgetStop = false;
    let timeStop = false;
    let longLines = false;
    let bigFiles = 0;
    let slow: string | undefined;
    // The Reins home is looked at once per call, and only when a file has more than one name.
    const homed = homeGuard(ctx.home);
    scan: for await (const [abs, below] of results(ctx, t, state, deadline)) {
      if (only && !only(below)) continue;
      if (now() > deadline) {
        timeStop = true;
        break;
      }
      const shown = toRel(abs, t.root, ctx.platform);
      // Every byte is charged to the budget: a file over the limit is skipped by its size, and its size still counts.
      let size: number;
      try {
        size = fs.lstatSync(abs).size;
      } catch {
        continue;
      }
      if (scanned + size > MAX_GREP_BYTES) {
        budgetStop = true;
        break;
      }
      scanned += size;
      if (size > MAX_GREP_FILE) {
        bigFiles++;
        continue;
      }
      let got: Bounded | 'notfile' | 'stopped';
      try {
        got = readBoundedSync(abs, MAX_GREP_FILE, () => now() > deadline);
      } catch {
        continue;
      }
      if (got === 'stopped') {
        timeStop = true;
        break;
      }
      if (got === 'notfile') continue;
      if (got.over) {
        bigFiles++;
        continue;
      }
      // A file that grew since the listing is charged for what was read.
      if (got.buf.length > size) scanned += got.buf.length - size;
      const home = homed(got.st);
      if (home !== 'ok') {
        if (state.single) return fail(home === 'home' ? HOME_WORDS : HOME_UNKNOWN_WORDS);
        continue;
      }
      if (isBinary(got.buf)) continue;
      const lines = got.buf.toString('utf8').split('\n');
      if (lines.some((l) => l.length > MAX_LINE)) longLines = true;
      sandbox.lines = lines;
      const room = Math.min(FILE_MS, deadline - now());
      let hit: number[] = [];
      try {
        if (room <= 0) throw Object.assign(new Error('out of time'), { code: 'ERR_SCRIPT_EXECUTION_TIMEOUT' });
        hit = MATCH.runInContext(sandbox, { timeout: room }) as number[];
      } catch (e) {
        if (code(e) !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw e;
        // The file's own 2 s ran out: the pattern is slow. The call's time ran out first: the deadline.
        if (room < FILE_MS) timeStop = true;
        else slow = shown;
        break;
      }
      if (mode === 'content') {
        for (const i of hit) {
          if (out.length >= MAX_MATCHES) {
            cut = true;
            break scan;
          }
          // The whole line is redacted first and cut after (a key must not be clipped into a prefix that no later pass can recognise).
          const line = lines[i]!.replace(/\r$/, '');
          out.push(`${shown}:${i + 1}:${line.length > LINE_SHOWN ? ctx.redact(line, LINE_SHOWN) + '...' : line}`);
        }
      } else if (hit.length) {
        if (out.length >= MAX_MATCHES) {
          cut = true;
          break;
        }
        out.push(mode === 'count' ? `${shown}:${hit.length}` : shown);
      }
    }
    if (ctx.signal.aborted) return fail('Interrupted.');
    const late = timeStop || state.stopped === 'deadline';
    const notes = [
      ...(cut ? [`[results cut at ${MAX_MATCHES}]`] : []),
      ...(bigFiles ? [`[skipped ${bigFiles} file${bigFiles === 1 ? '' : 's'} over ${MAX_GREP_FILE / 1024 / 1024} MB]`] : []),
      ...(budgetStop ? [`search stopped: scanned ${MAX_GREP_BYTES / 1024 / 1024} MB`] : []),
      ...(longLines ? [`[lines over ${MAX_LINE} characters were not searched]`] : []),
      ...(state.stopped === 'entries' ? [TOO_MANY] : []),
      ...(late ? [DEADLINE_WORDS('Grep')] : []),
      ...(slow !== undefined ? [`Grep stopped: the pattern is too slow on ${slow}`] : []),
    ];
    // A search that was stopped did not look everywhere: it never says that nothing was found.
    const incomplete = budgetStop || late || state.stopped === 'entries' || slow !== undefined;
    const body = out.length ? out.join('\n') : incomplete ? '' : 'No matches found.';
    const text = [body, ...notes].filter((s) => s !== '').join('\n');
    return slow !== undefined && !out.length ? fail(text) : ok(text);
  },
};

// ---- the shell --------------------------------------------------------------------------------------------------------------------

const shellSchema: Tool['schema'] = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'The command to run.' },
    timeout: { type: 'number', description: 'Seconds to wait (default 120, at most 600).', minimum: 1, maximum: 600 },
  },
  required: ['command'],
  additionalProperties: false,
};
/** The one shell tool the model is offered on this platform. */
export const shellToolName = (platform: NodeJS.Platform) => (platform === 'win32' ? 'PowerShell' : 'Bash');

const shell = (name: string, what: string): Tool => ({
  name,
  class: 'shell',
  description: `Runs a ${what} command in the project folder and returns its output. At most 30000 characters come back (the first 10000 and the last 20000).`,
  schema: shellSchema,
  refuse: (input, c) => (namesHome(input.command as string, c) ? HOME_NAMED_WORDS : undefined),
  // Belt and braces: the engine only finds the tool this platform offers; a call that gets here for the other one is an unknown tool.
  run: (input, ctx) => (name === shellToolName(ctx.platform) ? runShell(input as { command: string; timeout?: number }, ctx) : fail(noTool(name, ctx.platform, true))),
});

export const TOOLS: readonly Tool[] = [read, write, edit, glob, grep, shell('Bash', 'bash'), shell('PowerShell', 'PowerShell')];

/** A tool of the table, or undefined. Not a property lookup: the name is the model's. */
export const findTool = (name: string): Tool | undefined => TOOLS.find((t) => t.name === name);

/** What the model is offered: the file tools and this platform's shell. */
export const offered = (platform: NodeJS.Platform): Tool[] => TOOLS.filter((t) => t.class !== 'shell' || t.name === shellToolName(platform));

export const toolSpecs = (platform: NodeJS.Platform): ToolSpec[] => offered(platform).map((t) => ({ name: t.name, description: t.description, schema: t.schema }));

/** The class of a tool name; a name the table does not have is treated as a write (S11). */
export const classOf = (name: string): ToolClass => findTool(name)?.class ?? 'write';

export const noTool = (name: string, platform: NodeJS.Platform, hasTools: boolean) =>
  hasTools
    ? `Reins has no tool ${name.slice(0, 100)}; use one of: ${offered(platform).map((t) => t.name).join(', ')}.`
    : `Reins has no tool ${name.slice(0, 100)}; this model works without tools.`;

/** The first thing wrong with `input` for `tool`, naming the field, or undefined. Never throws. */
export function checkInput(tool: Tool, input: unknown): string | undefined {
  if (!isObj(input)) return `The input of ${tool.name} must be a JSON object with ${tool.schema.required.map((k) => `"${k}"`).join(', ')}.`;
  for (const k of tool.schema.required) if (input[k] === undefined) return `${tool.name}: "${k}" is required.`;
  for (const [k, spec] of Object.entries(tool.schema.properties)) {
    const v = input[k];
    if (v === undefined) continue;
    const okType =
      spec.type === 'string' ? typeof v === 'string'
      : spec.type === 'boolean' ? typeof v === 'boolean'
      : spec.type === 'integer' ? Number.isInteger(v)
      : typeof v === 'number' && Number.isFinite(v);
    if (!okType) return `${tool.name}: "${k}" must be ${spec.type === 'string' ? 'a string' : spec.type === 'boolean' ? 'true or false' : spec.type === 'integer' ? 'a whole number' : 'a number'}.`;
    if (spec.enum && !spec.enum.includes(v as string)) return `${tool.name}: "${k}" must be one of: ${spec.enum.join(', ')}.`;
    if (typeof v === 'number' && ((spec.minimum !== undefined && v < spec.minimum) || (spec.maximum !== undefined && v > spec.maximum))) {
      return `${tool.name}: "${k}" must be ${spec.minimum !== undefined ? `at least ${spec.minimum}` : ''}${spec.minimum !== undefined && spec.maximum !== undefined ? ' and ' : ''}${spec.maximum !== undefined ? `at most ${spec.maximum}` : ''}.`;
    }
  }
  return undefined;
}
