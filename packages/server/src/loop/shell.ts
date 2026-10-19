// The loop's shell tool (spec 4.2, 4.3, 8.3, 8.4): its own spawn, never `runCommand` (cmd.exe, a 200-line tail, no kill of the tree).
// Windows: a fixed bootstrap reads the command from stdin and runs it as ONE script. POSIX: `bash -c`, else `sh -c`, in its own process group.
// The shell is always started by an absolute path. The env comes from the host, worked out once per command; the only `process.env` read here is
// SystemRoot, to find the Windows folder.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { killTree } from '../proc.js';
import type { ToolOut } from './tools.js';

export interface ShellCtx {
  cwd: string;
  /** Works out the env the child gets, once per command. Undefined: the host has none that is safe, and nothing is run. */
  env?: (() => NodeJS.ProcessEnv) | undefined;
  /** A new redactor for one output stream. Undefined: the output cannot be made safe, and nothing is run. */
  redactStream?: (() => { push(text: string): string; end(): string }) | undefined;
  platform: NodeJS.Platform;
  signal: AbortSignal;
  redact: (text: string, max?: number) => string;
  redactAll: (text: string) => string;
  /** Whether a file exists (tests pass a fake to say that no shell is installed). */
  exists?: ((p: string) => boolean) | undefined;
}

export const DEFAULT_S = 120;
export const MAX_S = 600;
export const HEAD = 10_000;
export const TAIL = 20_000;
const LIMIT = HEAD + TAIL;
/** After the shell exits, how long the pipes get to drain before a background child that holds them open is let go. */
export const DRAIN_MS = 200;
/** After a timeout kill, how long to wait for the exit before the call ends anyway. */
export const KILL_WAIT_MS = 1000;

export const NO_ENV_WORDS = 'Blocked by Reins: Reins has no safe environment to run a command in.';
export const NO_REDACT_WORDS = 'Blocked by Reins: Reins cannot hide keys in the output of this command.';
export const HOME_NAMED_WORDS = 'Blocked by Reins: this command names the Reins home, which Reins keeps closed.';
export const NO_SHELL_WORDS = 'Cannot start the shell: no shell was found in the places Reins trusts.';

const fail = (text: string): ToolOut => ({ text, isError: true });

/** Seconds to wait: 1 to 600, 120 when it is not a number. The schema's maximum is advice; this is the enforcement. */
export const clampTimeout = (s: unknown): number => (typeof s === 'number' && Number.isFinite(s) ? Math.min(MAX_S, Math.max(1, s)) : DEFAULT_S);

const ci = (platform: NodeJS.Platform) => platform === 'win32' || platform === 'darwin';

// ---- the word scan (spec 4.3) -------------------------------------------------------------------------------------------------------
// ponytail: this only stops the plain mention of the Reins home. A command can still build the path at run time (variables, globs such as
// `.rei*` or `*.json`, 8.3 aliases, base64, a folder listing), and a shell can read anything the user can. The real guards are the approval
// (Task 13) and the key-free environment. Matching is case-insensitive on win32 and darwin, exact elsewhere; on win32 `\` and `/` are one
// separator, and a run of separators is one.

const realOrUndefined = (p: string) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return undefined;
  }
};

export const WORDS_FIXED = ['~/.reins', '~\\.reins', '$HOME/.reins', '${HOME}/.reins', '$env:USERPROFILE\\.reins', '%USERPROFILE%\\.reins', '%HOMEPATH%\\.reins', 'secrets.json', 'REINS_HOME'];

// The pattern sources: `.reins` as a whole name (not part of a longer word, `.reins-docs` or `x.reinsurance`; a dot after it is fine, Windows drops
// trailing dots), and a secrets file name with a wildcard. Every pattern must stay linear in the length of the command: this runs before any
// approval, on text the model wrote, and a backtracking pattern would stall the server.
const PATTERNS = ['(?<![\\w.-])\\.reins(?![\\w-])', 'secrets?[*?]'];

/** True when `command` names the Reins home by one of the plain spellings. */
export function namesHome(command: string, o: { home: string; platform: NodeJS.Platform }): boolean {
  const fold = (s: string) => {
    const t = o.platform === 'win32' ? s.replace(/\\/g, '/') : s;
    return (ci(o.platform) ? t.toLowerCase() : t).replace(/\/+/g, '/');
  };
  const homes = [o.home, realOrUndefined(o.home)].filter((h): h is string => !!h);
  const needles = [...homes.map((h) => h.replace(/[\\/]+$/, '')), ...WORDS_FIXED].filter((n) => n !== '').map(fold);
  const res = PATTERNS.map((p) => new RegExp(p, ci(o.platform) ? 'i' : ''));
  // The command as written, and with the characters a shell drops from a word (quotes, a backtick, a caret): s''ecrets.json is secrets.json.
  return [command, command.replace(/['"`^]/g, '')].map(fold).some((text) => needles.some((n) => text.includes(n)) || res.some((r) => r.test(text)));
}

// ---- the output ---------------------------------------------------------------------------------------------------------------------

const isHigh = (c: string | undefined) => c !== undefined && c >= '\ud800' && c <= '\udbff';
const isLow = (c: string | undefined) => c !== undefined && c >= '\udc00' && c <= '\udfff';

/**
 * Keeps the first HEAD characters, a rolling tail (trimmed only when it doubles) and the total, of text that is ALREADY redacted. Memory is
 * bounded whatever the output. A cut never splits a surrogate pair.
 */
export class Collector {
  head = '';
  tail = '';
  total = 0;

  add(s: string) {
    if (s === '') return;
    this.total += s.length;
    if (this.head.length < HEAD) this.head += s.slice(0, HEAD - this.head.length);
    this.tail += s;
    if (this.tail.length > 2 * TAIL) this.tail = this.tail.slice(-TAIL);
  }

  /** Over 30,000 characters: the head, the cut said, the tail. The tail is only trimmed past double its size, so up to 30,000 it holds everything. */
  shape(): string {
    if (this.total <= LIMIT) return this.tail;
    const head = isHigh(this.head.at(-1)) ? this.head.slice(0, -1) : this.head;
    let tail = this.tail.slice(-TAIL);
    if (isLow(tail[0])) tail = tail.slice(1);
    return `${head}\n[${this.total - head.length - tail.length} characters cut]\n${tail}`;
  }
}

const withLine = (out: string, line: string) => `${out}${out === '' || out.endsWith('\n') ? '' : '\n'}${line}`;

// ---- the shell ----------------------------------------------------------------------------------------------------------------------

/**
 * The fixed ASCII text given to Windows PowerShell with -Command (the user's command never goes on the command line): UTF-8 without a BOM for
 * output, all of stdin read as UTF-8 to the end, ONE script block made from it and run once. `-Command -` would run stdin statement by
 * statement (a multi-line block is skipped, a `throw` does not stop the next line) and read it in the console code page.
 * Exit status is PowerShell's own: `exit N` in the command is N, a terminating error is 1, and the exit code of a last native program is NOT
 * passed on unless the command ends with `exit $LASTEXITCODE`.
 */
export const BOOTSTRAP =
  '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Text.UTF8Encoding]::new($false);' +
  '$r=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false));' +
  '$s=$r.ReadToEnd();$sb=[scriptblock]::Create($s);& $sb';

/**
 * The shell to start, by absolute path only: Windows PowerShell under SystemRoot, or bash, else sh, in the fixed system places. Undefined when
 * there is none (the caller fails; it never falls back to a bare name).
 */
export function chooseShell(platform: NodeJS.Platform, exists: (p: string) => boolean, sysRoot: string): { file: string; bootstrap: boolean } | undefined {
  if (platform === 'win32') {
    const file = path.win32.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return exists(file) ? { file, bootstrap: true } : undefined;
  }
  const file = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/bin/sh', '/usr/bin/sh'].find(exists);
  return file ? { file, bootstrap: false } : undefined;
}

/**
 * Runs one command and gives its output (interleaved, head and tail kept) with `exit N` at the end. Never throws. A timeout or an abort kills the
 * whole tree. ponytail: a background child that outlives the shell is not killed after a normal exit (the pipes are let go after 200 ms); a
 * persistent shell or job tools would be the way to own such children.
 */
export function runShell(input: { command: string; timeout?: number }, ctx: ShellCtx): Promise<ToolOut> {
  if (!ctx.env) return Promise.resolve(fail(NO_ENV_WORDS));
  if (!ctx.redactStream) return Promise.resolve(fail(NO_REDACT_WORDS));
  if (typeof input.command !== 'string' || input.command.trim() === '') return Promise.resolve(fail('The command is empty.'));
  if (ctx.signal.aborted) return Promise.resolve(fail('Interrupted.'));
  let env: NodeJS.ProcessEnv;
  try {
    env = ctx.env();
  } catch {
    return Promise.resolve(fail(NO_ENV_WORDS));
  }
  const secs = clampTimeout(input.timeout);
  const sh = chooseShell(ctx.platform, ctx.exists ?? fs.existsSync, process.env.SystemRoot ?? 'C:\\Windows');
  if (!sh) return Promise.resolve(fail(NO_SHELL_WORDS));
  const make = ctx.redactStream;

  return new Promise<ToolOut>((resolve) => {
    const out = new Collector();
    let child: ChildProcess;
    let finished = false;
    let timedOut = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const timers: ReturnType<typeof setTimeout>[] = [];
    // ponytail: a secret that overlaps itself (a periodic value such as `aaaaaaaa`) can make the text a stream redactor holds back grow without
    // bound, and cost quadratic time, for a command that prints that pattern. Real API keys do not repeat; a bound belongs in secrets.ts `safeLength`.
    // Each stream is decoded and redacted on its own, so a key printed on one stream is whole to its redactor however the other one interleaves.
    const pipes: Array<{ dec: StringDecoder; red: ReturnType<typeof make> }> = [];

    const done = (result?: ToolOut) => {
      if (finished) return;
      finished = true;
      for (const t of timers) clearTimeout(t);
      ctx.signal.removeEventListener('abort', onAbort);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      if (result) return resolve(result);
      for (const p of pipes) {
        out.add(p.red.push(p.dec.end()));
        out.add(p.red.end());
      }
      const body = out.shape();
      if (timedOut) return resolve(fail(withLine(body, `[timed out after ${secs} s]`)));
      const n = exit?.code ?? exit?.signal ?? 'unknown';
      resolve({ text: withLine(body, `exit ${n}`), ...(exit?.code === 0 ? {} : { isError: true }) });
    };
    const onAbort = () => {
      killTree(child?.pid, env);
      done(fail('Interrupted.'));
    };

    try {
      child = spawn(sh.file, sh.bootstrap ? ['-NoProfile', '-NonInteractive', '-Command', BOOTSTRAP] : ['-c', input.command], {
        cwd: ctx.cwd,
        env,
        stdio: [sh.bootstrap ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: ctx.platform !== 'win32',
      });
    } catch (e) {
      return resolve(fail(`Cannot start the shell: ${ctx.redactAll(e instanceof Error ? e.message : String(e))}`));
    }
    child.on('error', (e) => done(fail(`Cannot start the shell: ${ctx.redactAll(e.message)}`)));
    for (const stream of [child.stdout, child.stderr]) {
      const pipe = { dec: new StringDecoder('utf8'), red: make() };
      pipes.push(pipe);
      stream?.on('data', (b: Buffer) => {
        if (!finished) out.add(pipe.red.push(pipe.dec.write(b)));
      });
      // A pipe that breaks ends the call with a plain result; what the command is still doing cannot be seen any more, so its tree is stopped.
      stream?.on('error', (e) => {
        if (finished) return;
        killTree(child.pid, env);
        done(fail(`The output of the command could not be read: ${ctx.redactAll(e.message)}`));
      });
    }
    if (sh.bootstrap) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(input.command);
    }
    child.on('exit', (code, signal) => {
      if (finished) return;
      exit = { code, signal };
      timers.push(setTimeout(() => done(), DRAIN_MS));
    });
    child.on('close', () => done());
    timers.push(
      setTimeout(() => {
        timedOut = true;
        killTree(child.pid, env);
        // The tree is gone; if the exit event still does not come, do not wait for it for ever.
        timers.push(setTimeout(() => done(), KILL_WAIT_MS));
      }, secs * 1000),
    );
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });
  });
}
