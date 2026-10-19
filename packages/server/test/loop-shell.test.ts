// The shell tool (Task 12), called directly except where a test says it goes through the engine. Commands are chosen by platform; a test that
// cannot run on this platform says SKIPPED and why. Helper programs are small node scripts written to a temp folder, so no test depends on quoting.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent, Policy } from '@reins/core';
import { Redactor, StreamRedactor, childEnv, redactCut, setKey } from '../src/secrets.js';
import { KEY, rig, toolResults, type Rig } from './loop-harness.js';
import { tempHome } from './mods-harness.js';

const spawned = vi.hoisted(() => [] as Array<{ file: string; args: string[]; opts: Record<string, any>; child: any }>);
const noKill = vi.hoisted(() => ({ on: false }));
/** Things a test makes `spawn` do: throw with this message, or abort this controller while the child is being made. */
const fault = vi.hoisted(() => ({ throwMsg: undefined as string | undefined, abort: undefined as AbortController | undefined }));
vi.mock('node:child_process', async (orig) => {
  const m = await orig<typeof import('node:child_process')>();
  return {
    ...m,
    spawn: ((file: string, args: string[], opts: Record<string, any>) => {
      if (fault.throwMsg) throw new Error(fault.throwMsg);
      const child = (m.spawn as (...a: unknown[]) => unknown)(file, args, opts);
      spawned.push({ file, args, opts, child });
      fault.abort?.abort();
      return child;
    }) as typeof m.spawn,
  };
});
vi.mock('../src/proc.js', async (orig) => {
  const m = await orig<typeof import('../src/proc.js')>();
  return { ...m, killTree: (...a: Parameters<typeof m.killTree>) => (noKill.on ? undefined : m.killTree(...a)) };
});

const { BOOTSTRAP, Collector, HOME_NAMED_WORDS, NO_ENV_WORDS, NO_REDACT_WORDS, NO_SHELL_WORDS, WORDS_FIXED, chooseShell, clampTimeout, namesHome, runShell } =
  await import('../src/loop/shell.js');
const { findTool, shellToolName } = await import('../src/loop/tools.js');
const { hostSend, shellEnvFrom, startMods } = await import('../src/engines.js');
const { killTree } = await import('../src/proc.js');
type ShellCtx = import('../src/loop/shell.js').ShellCtx;

const win = process.platform === 'win32';
const SHELL = shellToolName(process.platform);
const WRITE_MODE: Policy = { mode: 'write', guards: [], allowShell: true };
const CANNOT_ASK = 'Blocked by Reins: this needs your approval, which this build cannot ask yet.';
const plain = (t: string, max?: number) => (max === undefined ? t : t.slice(0, max));
const skip = (t: { skip: (m: string) => void }, why: string) => t.skip(`SKIPPED: ${why}`);
const KEY43 = 'sk-fake-' + 'abcdefghij'.repeat(3) + 'ABCDE';

let tmp = '';
let cwd = '';
let scripts = '';
beforeEach(() => {
  spawned.length = 0;
  noKill.on = false;
  fault.throwMsg = undefined;
  fault.abort = undefined;
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-shell-')));
  cwd = path.join(tmp, 'proj');
  scripts = path.join(tmp, 'scripts');
  fs.mkdirSync(cwd);
  fs.mkdirSync(scripts);
  const js = (name: string, body: string) => fs.writeFileSync(path.join(scripts, name), body);
  // fill.js H:10000 KEY M:70000 EMOJI -> that many of that letter, KEY = the env var KEYV, EMOJI = one emoji, then a newline.
  js('fill.js', `const seg = (s) => (s === 'KEY' ? process.env.KEYV : s === 'EMOJI' ? '\\ud83d\\ude00' : s[0].repeat(Number(s.slice(2))));\nprocess.stdout.write(process.argv.slice(2).map(seg).join('') + '\\n');`);
  js('big.js', `let n = 5000; const line = 'x'.repeat(1023) + '\\n';\n(function next() { while (n > 0) { n--; if (!process.stdout.write(line)) return process.stdout.once('drain', next); } })();`);
  js('alt.js', `let i = 0;\n(function step() { if (i >= 5) return; process.stdout.write('o' + i + '\\n'); setTimeout(() => { process.stderr.write('e' + i + '\\n'); i++; setTimeout(step, 40); }, 40); })();`);
  js('multi.js', `const buf = Buffer.from('é😀'.repeat(100)); let i = 0;\n(function step() { if (i >= buf.length) return; process.stdout.write(buf.subarray(i, i + 7)); i += 7; setTimeout(step, 3); })();`);
  // split.js -> 20 characters of the key on stdout, ERR on stderr, the rest of the key on stdout.
  js('split.js', `const k = process.env.KEYV;\nprocess.stdout.write(k.slice(0, 20));\nsetTimeout(() => { process.stderr.write('ERR'); setTimeout(() => process.stdout.write(k.slice(20)), 80); }, 80);`);
  // chunk.js -> the key in two writes of one stream.
  js('chunk.js', `const k = process.env.KEYV;\nprocess.stdout.write('a' + k.slice(0, 10));\nsetTimeout(() => process.stdout.write(k.slice(10) + 'b'), 80);`);
  // pre.js -> output that ends on the first 20 characters of the key.
  js('pre.js', `process.stdout.write('abc' + process.env.KEYV.slice(0, 20));`);
  // tree.js FILE -> starts a child that sleeps, writes "<own pid> <child pid>" to FILE, then sleeps itself.
  js('tree.js', `const cp = require('node:child_process');\nconst c = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });\nrequire('node:fs').writeFileSync(process.argv[2], process.pid + ' ' + c.pid);\nsetTimeout(() => {}, 60000);`);
  // bg.js FILE -> leaves a detached child that keeps the output pipes open for 15 s, writes its pid to FILE, and exits.
  js('bg.js', `const cp = require('node:child_process');\nconst c = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'inherit', detached: true });\nc.unref();\nrequire('node:fs').writeFileSync(process.argv[2], String(c.pid));`);
});
afterEach(async () => {
  vi.restoreAllMocks();
  // A process that was just killed may hold its folder for a moment on Windows.
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i >= 40) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

const ENV = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...process.env, NODE: process.execPath, ...extra });
const plainStream = () => ({ push: (s: string) => s, end: () => '' });
const ctxOf = (extra: Partial<ShellCtx> = {}): ShellCtx => {
  const env = ENV();
  return { cwd, env: () => env, redactStream: plainStream, platform: process.platform, signal: new AbortController().signal, redact: plain, redactAll: (t) => t, ...extra };
};
/** A command line that runs one of the helper scripts with node, in the shell of this platform. */
const node = (script: string, ...args: string[]) => `${win ? '& $env:NODE' : '"$NODE"'} '${path.join(scripts, script)}'${args.map((a) => ` ${a}`).join('')}`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
};
async function until(ok: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (ok()) return true;
  return ok();
}
async function pidsFrom(file: string): Promise<number[]> {
  expect(await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== '', 20_000), `${file} was written`).toBe(true);
  return fs.readFileSync(file, 'utf8').trim().split(' ').map(Number);
}

describe('the command runs as one script (spec 4.2)', () => {
  it('Windows: Get-ChildItem lists the cwd; a two-line script is one script; exit 3 is reported', async (t) => {
    if (!win) return skip(t, 'PowerShell is the Windows shell');
    fs.writeFileSync(path.join(cwd, 'marker-file.txt'), 'x');
    const ls = await runShell({ command: 'Get-ChildItem' }, ctxOf());
    expect(ls.text).toContain('marker-file.txt');
    expect(ls.text.endsWith('exit 0')).toBe(true);
    expect(ls.isError).toBeUndefined();
    const two = await runShell({ command: '$x = 2\n$x * 21' }, ctxOf());
    expect(two.text).toBe('42\r\nexit 0');
    const three = await runShell({ command: 'exit 3' }, ctxOf());
    expect(three).toEqual({ text: 'exit 3', isError: true });
  }, 60_000);

  it('POSIX: bash (else sh) runs it; exit 3 is reported', async (t) => {
    if (win) return skip(t, 'bash or sh is the POSIX shell');
    expect((await runShell({ command: 'echo $0' }, ctxOf())).text).toMatch(/(bash|sh)\nexit 0$/);
    expect(await runShell({ command: 'exit 3' }, ctxOf())).toEqual({ text: 'exit 3', isError: true });
  }, 60_000);

  it('a non-zero exit is an error and exit 0 is not; the output comes before the exit line', async () => {
    const bad = await runShell({ command: win ? 'Write-Output hi; exit 2' : 'echo hi; exit 2' }, ctxOf());
    expect(bad.text).toMatch(/^hi\r?\nexit 2$/);
    expect(bad.isError).toBe(true);
    const good = await runShell({ command: win ? 'Write-Output hi' : 'echo hi' }, ctxOf());
    expect(good.text).toMatch(/^hi\r?\nexit 0$/);
    expect(good.isError).toBeUndefined();
  }, 60_000);

  it('spawns by absolute path without a shell wrapper, in the cwd, with the env the host gave and a hidden window', async () => {
    const env = ENV({ ORDINARY_T12: 'fine' });
    await runShell({ command: win ? 'Write-Output hi' : 'echo hi' }, ctxOf({ env: () => env }));
    expect(spawned).toHaveLength(1);
    const { file, args, opts } = spawned[0]!;
    expect(opts.shell).toBeFalsy();
    expect(opts.env).toBe(env);
    expect(opts.cwd).toBe(cwd);
    expect(opts.windowsHide).toBe(true);
    expect(opts.detached).toBe(!win);
    expect(path.isAbsolute(file)).toBe(true);
    if (win) {
      expect(file).toBe(path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
      // The user's command is not on the command line: only the fixed bootstrap is.
      expect(args).toEqual(['-NoProfile', '-NonInteractive', '-Command', BOOTSTRAP]);
      expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    } else {
      expect(file).toMatch(/\/(bash|sh)$/);
      expect(args).toEqual(['-c', 'echo hi']);
      expect(opts.stdio[0]).toBe('ignore');
    }
  }, 60_000);

  it('the bootstrap is plain ASCII, one line, with no double quote', () => {
    expect(BOOTSTRAP).toMatch(/^[\x20-\x7e]+$/);
    expect(BOOTSTRAP).not.toContain('"');
  });

  it('a file named like the shell in the project (or in the folders on PATH order) is never run', async () => {
    for (const name of ['powershell.exe', 'bash', 'sh', 'taskkill.exe']) fs.writeFileSync(path.join(cwd, name), 'not a program');
    const res = await runShell({ command: win ? 'Write-Output ok' : 'echo ok' }, ctxOf());
    expect(res.text).toMatch(/^ok\r?\nexit 0$/);
    expect(path.dirname(spawned[0]!.file)).not.toBe(cwd);
  }, 60_000);

  it('a shell that cannot start (spawn error) is a plain error result, not a throw', async () => {
    const res = await runShell({ command: 'echo hi' }, ctxOf({ exists: () => true, platform: win ? 'linux' : 'win32' }));
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/^Cannot start the shell: /);
  }, 60_000);

  it('no shell in the trusted places is a plain error and nothing is spawned (no fall back to a bare name)', async () => {
    const res = await runShell({ command: 'echo hi' }, ctxOf({ exists: () => false }));
    expect(res).toEqual({ text: NO_SHELL_WORDS, isError: true });
    expect(spawned).toHaveLength(0);
  });
});

describe('which shell (absolute paths only)', () => {
  const only = (...have: string[]) => (p: string) => have.includes(p);
  it('Windows PowerShell under SystemRoot, or nothing', () => {
    const ps = 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    expect(chooseShell('win32', only(ps), 'D:\\Win')).toEqual({ file: ps, bootstrap: true });
    expect(chooseShell('win32', () => false, 'D:\\Win')).toBeUndefined();
    // Never bash.exe or sh.exe, however they would be found.
    expect(chooseShell('win32', (p) => !p.endsWith('powershell.exe'), 'D:\\Win')).toBeUndefined();
  });

  it('POSIX: bash in the three places in order, then /bin/sh, then /usr/bin/sh, else nothing', () => {
    expect(chooseShell('linux', only('/bin/bash', '/usr/bin/bash', '/bin/sh'), 'x')).toEqual({ file: '/bin/bash', bootstrap: false });
    expect(chooseShell('linux', only('/usr/bin/bash', '/usr/local/bin/bash'), 'x')?.file).toBe('/usr/bin/bash');
    expect(chooseShell('linux', only('/usr/local/bin/bash', '/bin/sh'), 'x')?.file).toBe('/usr/local/bin/bash');
    expect(chooseShell('darwin', only('/bin/sh', '/usr/bin/sh'), 'x')?.file).toBe('/bin/sh');
    expect(chooseShell('linux', only('/usr/bin/sh'), 'x')?.file).toBe('/usr/bin/sh');
    expect(chooseShell('linux', only(), 'x')).toBeUndefined();
  });
});

describe('PowerShell runs the whole command as ONE script, in UTF-8 (Windows)', () => {
  const run = (command: string) => runShell({ command }, ctxOf());

  it('a multi-line if/else block runs, and the statement after it', async (t) => {
    if (!win) return skip(t, 'PowerShell is the Windows shell');
    const res = await run('if ($true) {\n  "in-if"\n} else {\n  "else"\n}\n"after"');
    expect(res.text).toBe('in-if\r\nafter\r\nexit 0');
  }, 60_000);

  it('a terminating error stops the script, says what happened, and the exit is not 0', async (t) => {
    if (!win) return skip(t, 'PowerShell is the Windows shell');
    const res = await run('throw "FAKE-BOOM"\n"line-after-the-throw"');
    expect(res.isError).toBe(true);
    expect(res.text).toContain('FAKE-BOOM');
    expect(res.text).not.toMatch(/^line-after-the-throw/m);
    expect(res.text.endsWith('exit 1')).toBe(true);
  }, 60_000);

  it('Write-Error is not fatal: the next line runs', async (t) => {
    if (!win) return skip(t, 'PowerShell is the Windows shell');
    const res = await run('Write-Error "soft"\n"line-after"');
    expect(res.text).toMatch(/^line-after\r?$/m);
    expect(res.text.endsWith('exit 0')).toBe(true);
  }, 60_000);

  it('exit N inside the command is the exit; a last native exit is not passed on unless the command says so', async (t) => {
    if (!win) return skip(t, 'PowerShell is the Windows shell');
    const native = `& $env:NODE -e 'process.exit(7)'`;
    expect((await run(`${native}\nexit $LASTEXITCODE`)).text).toBe('exit 7');
    // PowerShell's own rule: without `exit $LASTEXITCODE` the native program's 7 is dropped.
    expect((await run(native)).text).toMatch(/exit [01]$/);
  }, 60_000);

  it('non-ASCII text reaches PowerShell as the same code points (checked as numbers, not by echo)', async (t) => {
    if (!win) return skip(t, 'PowerShell is the Windows shell');
    const res = await run('[int[]][char[]]"\u00e9\u4e2d\ud83d\ude00" -join ","');
    expect(res.text).toBe('233,20013,55357,56832\r\nexit 0');
    // and it comes back out as UTF-8
    const out = await run('"\u00e9\u4e2d\ud83d\ude00"');
    expect(out.text).toBe('\u00e9\u4e2d\ud83d\ude00\r\nexit 0');
  }, 60_000);

  it('Read-Host fails fast under -NonInteractive', async (t) => {
    if (!win) return skip(t, 'PowerShell is the Windows shell');
    const t0 = Date.now();
    const res = await run('Read-Host "x"\n"after"');
    expect(res.text).toContain('NonInteractive');
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 60_000);
});

describe('the output (spec 4.2, 8.3)', () => {
  it('100,000 characters keep the first 10,000 and the last 20,000, say how many were cut, and end with exit 0', async () => {
    const res = await runShell({ command: node('fill.js', 'H:10000', 'M:70000', 'T:20000') }, ctxOf());
    // 100,000 characters and a newline: 70,001 are cut.
    expect(res.text).toBe(`${'H'.repeat(10_000)}\n[70001 characters cut]\n${'T'.repeat(19_999)}\nexit 0`);
    expect(res.isError).toBeUndefined();
  }, 60_000);

  it('output of 30,000 characters or fewer is kept whole', async () => {
    const res = await runShell({ command: node('fill.js', 'a:15000', 'z:14000') }, ctxOf());
    expect(res.text).toBe(`${'a'.repeat(15_000)}${'z'.repeat(14_000)}\nexit 0`);
  }, 60_000);

  it('stdout and stderr come in the order they arrived', async () => {
    const res = await runShell({ command: node('alt.js') }, ctxOf());
    expect(res.text.split(/\r?\n/)).toEqual(['o0', 'e0', 'o1', 'e1', 'o2', 'e2', 'o3', 'e3', 'o4', 'e4', 'exit 0']);
  }, 60_000);

  it('characters split across chunk boundaries survive (one decoder per stream)', async () => {
    const res = await runShell({ command: node('multi.js') }, ctxOf());
    expect(res.text).toBe(`${'é😀'.repeat(100)}\nexit 0`);
  }, 60_000);

  it('an emoji across the end of the head or the start of the tail is never cut in half', async () => {
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    // The pair sits at 9,999 and 10,000.
    const head = await runShell({ command: node('fill.js', 'x:9999', 'EMOJI', 'y:60000') }, ctxOf());
    expect(head.text.startsWith(`${'x'.repeat(9999)}\n[`)).toBe(true);
    expect(lone.test(head.text)).toBe(false);
    // 60,001 characters: the tail starts at 40,001, the second half of the pair.
    const tail = await runShell({ command: node('fill.js', 'x:40000', 'EMOJI', 'y:19998') }, ctxOf());
    expect(tail.text).toContain('characters cut]\n' + 'y'.repeat(19_998) + '\nexit 0');
    expect(lone.test(tail.text)).toBe(false);
    // The count says what was really left out (the dropped half of the pair is counted).
    expect(tail.text).toContain('\n[30002 characters cut]\n');
  }, 60_000);

  it('memory stays bounded: 5 MB of output is never held whole', async () => {
    const c = new Collector();
    const chunk = 'x'.repeat(1023) + '\n';
    for (let i = 0; i < 5000; i++) c.add(chunk);
    expect(c.total).toBe(5000 * 1024);
    expect(c.head.length + c.tail.length).toBeLessThan(100_000);
    const res = await runShell({ command: node('big.js') }, ctxOf());
    expect(res.text.length).toBeLessThan(31_000);
    // A failure must not print 31,000 characters, so the check is a plain boolean.
    expect(res.text.includes('\n[5090000 characters cut]\n')).toBe(true);
    expect(res.text.endsWith('exit 0')).toBe(true);
  }, 120_000);
});

describe('timeout and abort kill the whole tree', () => {
  it('the timeout is clamped to 1..600 seconds, 120 when it is not a number', () => {
    expect([0, -5, 0.2, 1, 30, 600, 99_999].map(clampTimeout)).toEqual([1, 1, 1, 1, 30, 600, 600]);
    expect([undefined, NaN, Infinity, '5'].map(clampTimeout)).toEqual([120, 120, 120, 120]);
  });

  it('a timeout of 0 runs for 1 second, not none', async () => {
    const res = await runShell({ command: win ? 'Start-Sleep -Seconds 60' : 'sleep 60', timeout: 0 }, ctxOf());
    expect(res.isError).toBe(true);
    expect(res.text).toContain('[timed out after 1 s]');
  }, 60_000);

  it('a command that runs too long is killed with everything it started, and the words say so', async () => {
    const file = path.join(tmp, 'pids.txt');
    const res = await runShell({ command: node('tree.js', `'${file}'`), timeout: 2 }, ctxOf());
    expect(res.isError).toBe(true);
    expect(res.text).toContain('[timed out after 2 s]');
    expect(res.text).not.toContain('exit 0');
    const pids = await pidsFrom(file);
    expect(pids).toHaveLength(2);
    expect(await until(() => pids.every((p) => !alive(p)), 1000), `still running: ${pids.filter(alive)}`).toBe(true);
  }, 60_000);

  it('when the kill does nothing, the call still ends about 1 second after the timeout (not later)', async () => {
    noKill.on = true;
    const t0 = Date.now();
    const res = await runShell({ command: win ? 'Start-Sleep -Seconds 60' : 'sleep 60', timeout: 1 }, ctxOf());
    const took = Date.now() - t0;
    const child = spawned[0]!.child;
    noKill.on = false;
    killTree(child.pid);
    expect(res.text).toContain('[timed out after 1 s]');
    expect(took).toBeGreaterThanOrEqual(1900);
    expect(took).toBeLessThan(3500);
  }, 60_000);

  it('an abort ends the call as Interrupted and the tree (shell, its child and theirs) is gone within 1 second', async () => {
    const file = path.join(tmp, 'pids.txt');
    const ac = new AbortController();
    const running = runShell({ command: node('tree.js', `'${file}'`) }, ctxOf({ signal: ac.signal }));
    const pids = await pidsFrom(file);
    const t0 = Date.now();
    ac.abort();
    expect(await running).toEqual({ text: 'Interrupted.', isError: true });
    expect(await until(() => pids.every((p) => !alive(p)), 1000 - (Date.now() - t0)), `still running: ${pids.filter(alive)}`).toBe(true);
  }, 60_000);

  it('an already aborted signal runs nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await runShell({ command: 'echo hi' }, ctxOf({ signal: ac.signal }))).toEqual({ text: 'Interrupted.', isError: true });
    expect(spawned).toHaveLength(0);
  });

  it('an abort that comes while the child is being made ends the call as Interrupted and kills the tree', async () => {
    const ac = new AbortController();
    fault.abort = ac;
    const res = await runShell({ command: win ? 'Start-Sleep -Seconds 60' : 'sleep 60' }, ctxOf({ signal: ac.signal }));
    expect(res).toEqual({ text: 'Interrupted.', isError: true });
    const pid = spawned[0]!.child.pid as number;
    expect(await until(() => !alive(pid), 1000), 'the shell is still running').toBe(true);
  }, 60_000);

  it('a synchronous spawn failure is a plain result with the key hidden', async () => {
    fault.throwMsg = `spawn failed near ${KEY}`;
    const res = await runShell({ command: 'echo hi' }, ctxOf({ redactAll: (t) => t.split(KEY).join('[key Reins]') }));
    expect(res).toEqual({ text: 'Cannot start the shell: spawn failed near [key Reins]', isError: true });
  });

  it('an error on the stdin pipe after the start is absorbed (Windows: stdin is a pipe there)', async (t) => {
    if (!win) return skip(t, 'on POSIX stdin is not a pipe');
    const ac = new AbortController();
    const running = runShell({ command: 'Start-Sleep -Seconds 60' }, ctxOf({ signal: ac.signal }));
    expect(() => spawned[0]!.child.stdin.emit('error', new Error('EPIPE'))).not.toThrow();
    ac.abort();
    expect(await running).toEqual({ text: 'Interrupted.', isError: true });
  }, 60_000);

  it('a late exit after the call is over starts no timer', async () => {
    const ac = new AbortController();
    const running = runShell({ command: win ? 'Start-Sleep -Seconds 60' : 'sleep 60' }, ctxOf({ signal: ac.signal }));
    const child = spawned[0]!.child;
    const timers = vi.spyOn(globalThis, 'setTimeout');
    ac.abort();
    await running;
    const before = timers.mock.calls.length;
    child.emit('exit', 0, null);
    expect(timers.mock.calls.length).toBe(before);
  }, 60_000);
});

describe('the environment (spec 8.4)', () => {
  it('a key variable of the parent and a REINS_ variable are not in the child; an ordinary one is', async () => {
    const parent = ENV({ ANTHROPIC_API_KEY: 'sk-parent-0123456789', REINS_LIVE_ANTHROPIC_KEY: 'sk-live-0123456789', ORDINARY_T12: 'fine' });
    const env = childEnv(parent, ['ANTHROPIC_API_KEY']);
    const command = win
      ? '"[$env:ANTHROPIC_API_KEY][$env:REINS_LIVE_ANTHROPIC_KEY][$env:ORDINARY_T12]"'
      : 'echo "[$ANTHROPIC_API_KEY][$REINS_LIVE_ANTHROPIC_KEY][$ORDINARY_T12]"';
    const res = await runShell({ command }, ctxOf({ env: () => env }));
    expect(res.text).toMatch(/^\[\]\[\]\[fine\]\r?\nexit 0$/);
    // The same command with the parent's env shows what the child would have seen without the clean env.
    const leaky = await runShell({ command }, ctxOf({ env: () => parent }));
    expect(leaky.text).toContain('[sk-parent-0123456789][sk-live-0123456789][fine]');
  }, 60_000);

  it('no env, or no stream redactor: the command is refused and nothing is spawned (it never falls back)', async () => {
    expect(await runShell({ command: 'echo hi' }, ctxOf({ env: undefined }))).toEqual({ text: NO_ENV_WORDS, isError: true });
    expect(await runShell({ command: 'echo hi' }, ctxOf({ redactStream: undefined }))).toEqual({ text: NO_REDACT_WORDS, isError: true });
    expect(await runShell({ command: 'echo hi' }, ctxOf({ env: () => { throw new Error('x'); } }))).toEqual({ text: NO_ENV_WORDS, isError: true });
    expect(NO_ENV_WORDS).toBe('Blocked by Reins: Reins has no safe environment to run a command in.');
    expect(NO_REDACT_WORDS).toBe('Blocked by Reins: Reins cannot hide keys in the output of this command.');
    expect(spawned).toHaveLength(0);
  });

  it('the env is worked out once per command, when the command runs', async () => {
    const env = vi.fn(() => ENV());
    await runShell({ command: win ? 'Write-Output a' : 'echo a' }, ctxOf({ env }));
    await runShell({ command: win ? 'Write-Output a' : 'echo a' }, ctxOf({ env }));
    expect(env).toHaveBeenCalledTimes(2);
  }, 60_000);

  describe('the host\'s shell env (engines.ts)', () => {
    async function setup(env: NodeJS.ProcessEnv) {
      const h = tempHome();
      const mods = await startMods({ dir: h.home, env });
      const sent = hostSend(mods, { env, home: h.home });
      return { h, mods, shellEnv: shellEnvFrom(mods, env, sent.holdsSecret!) };
    }

    it('a key whose text is the placeholder itself (so redacting does not change it) still drops the variables that hold it', async () => {
      const env = { PATH: 'p', PRIMARY: '[key PRIMARY]', ALIAS: '[key PRIMARY]', EMBED: 'before-[key PRIMARY]-after', ORDINARY: 'fine' };
      const h = tempHome();
      const mods = await startMods({ dir: h.home, env });
      mods.registry.register('provider', 'prim', { manifest: { id: 'prim', auth: { style: 'bearer', keyEnv: ['PRIMARY'] } } });
      try {
        const sent = hostSend(mods, { env, home: h.home });
        expect(Object.keys(shellEnvFrom(mods, env, sent.holdsSecret!)()).sort()).toEqual(['ORDINARY', 'PATH']);
      } finally {
        mods.dispose();
        h.cleanup();
      }
    });

    it('a provider installed after the engine was made takes its key variable out of the next command\'s env', async () => {
      const env = { PATH: 'p', LATE_KEY_T12: 'sk-late-0123456789', ORDINARY: 'fine' };
      const { h, mods, shellEnv } = await setup(env);
      try {
        expect(shellEnv().LATE_KEY_T12).toBe('sk-late-0123456789');
        mods.registry.register('provider', 'late', { manifest: { id: 'late', auth: { style: 'bearer', keyEnv: ['LATE_KEY_T12'] } } });
        const next = shellEnv();
        expect(next).not.toHaveProperty('LATE_KEY_T12');
        expect(next.ORDINARY).toBe('fine');
      } finally {
        mods.dispose();
        h.cleanup();
      }
    });

    it('an alias of a key and a variable that holds a key inside a longer value are taken out; an ordinary variable stays', async () => {
      const k = 'sk-alias-0123456789';
      const env = { PATH: 'p', REAL_KEY_T12: k, ALIAS: k, EMBED: `before-${k}-after`, REINS_HOME: '/x', ORDINARY: 'fine' };
      const { h, mods, shellEnv } = await setup(env);
      try {
        mods.registry.register('provider', 'real', { manifest: { id: 'real', auth: { style: 'bearer', keyEnv: ['REAL_KEY_T12'] } } });
        const got = shellEnv();
        expect(Object.keys(got).sort()).toEqual(['ORDINARY', 'PATH']);
      } finally {
        mods.dispose();
        h.cleanup();
      }
    });
  });
});

describe('the Reins home word scan (spec 4.3)', () => {
  const HOMES: Array<[NodeJS.Platform, string]> = [['win32', 'C:\\Users\\Zed\\.reins'], ['linux', '/home/zed/.reins']];
  const scan = (command: string, platform: NodeJS.Platform, home = HOMES.find(([p]) => p === platform)![1]) => namesHome(command, { home, platform });

  // Every spelling the first review marked as caught, and the ones added after the second.
  const CAUGHT = [
    'cat ~/.reins/secrets.json', 'cat ~\\.reins\\x', 'cat $HOME/.reins/x', 'cat ${HOME}/.reins/x', 'type %USERPROFILE%\\.reins\\secrets.json', 'type %HOMEPATH%\\.reins\\a',
    'Get-Content $env:USERPROFILE\\.reins\\secrets.json', 'Get-Content "$env:HOME\\sub\\..\\.reins\\a"', 'cat foo/.reins//secrets', 'cat secrets.json', 'echo $REINS_HOME',
    'cat $HOME\\.reins', 'cat $env:USERPROFILE/.reins', 'Resolve-Path ~/.reins', 'echo $env:HOMEDRIVE$env:HOMEPATH\\.reins', 'cat .\\.reins\\secrets.json',
    'find / -name secrets.json', 'echo $env:REINS_HOME',
    // added after the review:
    'cat ${env:USERPROFILE}\\.reins/*', 'cat .reins/*', 'ls .reins', 'ls .reins;', 'cd ".reins"', 'ls (.reins)', 'x=.reins/a',
    "cat s''ecrets.json", 'cat se"cr"ets.json', 'cat s`ecrets.json', 'cat s^ecrets.json', 'cat secret?.json', 'cat secret*', 'ls secrets*', 'ls secrets?',
    'Get-ChildItem -Recurse -Filter secrets*', 'cat .reins//x/../secrets', 'cat ~//.reins', "cat '.re'ins/x",
    // round 2: punctuation around the name, trailing dots, a share
    'Get-Item .reins,.reins', 'ls;.reins', 'ls|.reins', 'echo hi >.reins', 'ls ,.reins', 'ls [.reins', 'ls @.reins', 'ls (.reins)', 'ls .reins,', 'ls .reins]',
    'ls .reins.', 'Get-Content .reins./marker', 'ls .reins ', 'ls \\\\server\\share\\.reins',
  ];
  const PASSES = [
    'cd ../reins-project', 'git log --grep=reins', 'npm run reins', 'cd .reins-docs', 'echo x.reinsurance', 'echo hello', 'git status', 'Get-Content notes.txt', 'echo $env:HOME',
    'cat reins.md', 'ls .git', 'cat secret.txt', 'echo secrets', 'echo "I keep secrets"', 'cd my.reins', 'ls .reinsfile',
    'ls .reinsx', 'cat /home/me/.reins-backup/x', "echo 'x.reinsurance'", 'echo foo.reins',
  ];

  it.each(CAUGHT)('refuses %s on both platform rules', (command) => {
    expect(scan(command, 'win32'), `win32: ${command}`).toBe(true);
    expect(scan(command, 'linux'), `linux: ${command}`).toBe(true);
  });

  it.each(PASSES)('lets %s through', (command) => {
    expect(scan(command, 'win32'), `win32: ${command}`).toBe(false);
    expect(scan(command, 'linux'), `linux: ${command}`).toBe(false);
  });

  // The list is written out here on purpose: a needle taken out of the source must turn a test red, not shrink the list.
  const NEEDLES = ['~/.reins', '~\\.reins', '$HOME/.reins', '${HOME}/.reins', '$env:USERPROFILE\\.reins', '%USERPROFILE%\\.reins', '%HOMEPATH%\\.reins', 'secrets.json', 'REINS_HOME'];
  it('the source has no needle that is not tested', () => {
    expect([...WORDS_FIXED]).toEqual(NEEDLES);
  });

  it.each(NEEDLES)('each fixed needle is enough on its own: %s', (needle) => {
    // Glued to a letter so only the plain substring needle can see it, not the whole-segment rule or another needle.
    for (const platform of ['win32', 'linux'] as const) expect(scan(`cat ${needle}zz`, platform), `${platform}: ${needle}`).toBe(true);
  });

  it('the absolute home path is named with either separator and with doubled ones on win32, and exactly on linux', () => {
    expect(scan('cat C:\\Users\\Zed\\.reins\\x', 'win32')).toBe(true);
    expect(scan('cat C:/Users/Zed/.reins/x', 'win32')).toBe(true);
    expect(scan('cat C:\\\\Users\\\\Zed\\\\.reins\\\\x', 'win32')).toBe(true);
    expect(scan('cat /home//zed///.reins/x', 'linux')).toBe(true);
    expect(scan('cat /home/zed/.reins/x', 'linux')).toBe(true);
  });

  it('case is ignored on win32 and darwin, and matters on linux', () => {
    expect(scan('CAT c:\\USERS\\zed\\.REINS\\X', 'win32')).toBe(true);
    expect(scan('cat ~/.REINS/x', 'win32')).toBe(true);
    expect(scan('cat SECRETS.JSON', 'win32')).toBe(true);
    expect(scan('cat /HOME/ZED/.REINS/x', 'darwin', '/home/zed/.reins')).toBe(true);
    expect(scan('cat /HOME/ZED/.REINS/x', 'linux')).toBe(false);
  });

  it('the scan is linear: 1 MB and 10 MB commands of the worst repeated shapes finish in time', () => {
    const shapes = ['$env:HOME ', 'plain text ', "'", 'secrets ', '.rein ', '$env:HOME$env:HOMEPATH '];
    for (const [size, limit] of [[1_000_000, 1000], [10_000_000, 5000]] as const) {
      for (const unit of shapes) {
        const command = unit.repeat(Math.ceil(size / unit.length));
        const t0 = Date.now();
        scan(command, 'win32');
        scan(command, 'linux');
        expect(Date.now() - t0, `${size} x ${JSON.stringify(unit)}`).toBeLessThan(limit);
      }
    }
  }, 120_000);

  it('the real path of a home that is a link is named too', (t) => {
    const real = path.join(tmp, 'real-home');
    const alias = path.join(tmp, 'alias-home');
    fs.mkdirSync(real);
    try {
      fs.symlinkSync(real, alias, win ? 'junction' : 'dir');
    } catch (e) {
      return skip(t, `links cannot be created here (${(e as Error).message})`);
    }
    expect(namesHome(`cat ${real}/x`, { home: alias, platform: process.platform })).toBe(true);
    expect(namesHome(`cat ${alias}/x`, { home: alias, platform: process.platform })).toBe(true);
  });

  it('the shell tools carry the scan as their refuse, with words that mention neither guard nor read-only', () => {
    for (const name of ['Bash', 'PowerShell']) {
      const tool = findTool(name)!;
      const ctx = { home: path.join(tmp, 'home'), cwd, platform: process.platform };
      expect(tool.refuse!({ command: 'cat ~/.reins/secrets.json' }, ctx)).toBe(HOME_NAMED_WORDS);
      expect(tool.refuse!({ command: 'echo hi' }, ctx)).toBeUndefined();
    }
    expect(HOME_NAMED_WORDS).toBe('Blocked by Reins: this command names the Reins home, which Reins keeps closed.');
    expect(HOME_NAMED_WORDS).not.toMatch(/guard|read-only/i);
  });
});

describe('redaction of the output: redacted first, per stream, then collected (spec 8.3)', () => {
  function redactors(key = KEY) {
    const home = path.join(tmp, 'rhome');
    fs.mkdirSync(home, { recursive: true });
    setKey(home, 'p', key);
    const r = new Redactor({ home, env: {}, keyEnvNames: () => ['P_API_KEY'] });
    return { redact: (t: string, max?: number) => redactCut(r, t, max), redactAll: (t: string) => r.redact(t), redactStream: () => new StreamRedactor(r) };
  }
  /** The longest piece of the key's start or end that shows in `text` (8 or more characters), or undefined. */
  const leaks = (text: string, key: string) => {
    for (let n = 8; n < key.length; n++) for (const piece of [key.slice(0, n), key.slice(-n)]) if (text.includes(piece)) return piece;
    return undefined;
  };
  const withKey = (key: string) => ctxOf({ env: () => ENV({ KEYV: key }), ...redactors(key) });

  it('the saved key printed by a command is redacted', async () => {
    const res = await runShell({ command: node('fill.js', 'a:5', 'KEY', 'b:5') }, withKey(KEY));
    expect(res.text).toBe('aaaaa[key Reins]bbbbb\nexit 0');
  }, 60_000);

  it('a key across the head cut (at 9,990) shows no prefix or suffix of 8 or more characters', async () => {
    const res = await runShell({ command: node('fill.js', 'x:9990', 'KEY', 'z:80000') }, withKey(KEY43));
    expect(res.text).toContain('characters cut]');
    expect(res.text).not.toContain(KEY43);
    expect(leaks(res.text, KEY43)).toBeUndefined();
    expect(res.text.startsWith('x'.repeat(9990))).toBe(true);
  }, 60_000);

  it.each([39_960, 39_975, 39_990, 39_999, 40_000])('a 43-character key at %i in 60,000 characters, with 100 copies after it, never shows a piece of 8 or more', async (at) => {
    const copies = Array.from({ length: 100 }, () => ['z:5', 'KEY']).flat();
    const rest = 60_000 - at - 43 - 100 * 48;
    const res = await runShell({ command: node('fill.js', `x:${at}`, 'KEY', ...copies, `y:${rest}`) }, withKey(KEY43));
    expect(res.text).toContain('characters cut]');
    expect(res.text).not.toContain(KEY43);
    expect(leaks(res.text, KEY43)).toBeUndefined();
  }, 60_000);

  it('the review\'s layout: the key at 38,956 and 100 copies after it, 60,000 characters', async () => {
    const copies = Array.from({ length: 100 }, () => ['z:5', 'KEY']).flat();
    const res = await runShell({ command: node('fill.js', 'x:38956', 'KEY', ...copies, `y:${60_000 - 38_956 - 43 - 100 * 48}`) }, withKey(KEY43));
    expect(leaks(res.text, KEY43)).toBeUndefined();
    expect(res.text).toContain('[key Reins]');
  }, 60_000);

  it('a key across 30,000 shows no piece of 8 or more', async () => {
    const res = await runShell({ command: node('fill.js', 'x:29990', 'KEY', 'y:30000') }, withKey(KEY43));
    expect(leaks(res.text, KEY43)).toBeUndefined();
    expect(res.text).not.toContain(KEY43);
  }, 60_000);

  it('a 2,048-character key at 38,500 shows nothing of itself', async () => {
    const big = randomBytes(1024).toString('hex');
    expect(big).toHaveLength(2048);
    const res = await runShell({ command: node('fill.js', 'x:38500', 'KEY', `z:${60_000 - 38_500 - 2048}`) }, withKey(big));
    expect(res.text).toContain('characters cut]');
    expect(leaks(res.text, big)).toBeUndefined();
    // no 8-character window of it at all
    for (let i = 0; i + 8 <= big.length; i += 3) expect(res.text.includes(big.slice(i, i + 8)), `window ${i}`).toBe(false);
  }, 60_000);

  it('a key printed as 20 characters on stdout, ERR on stderr and the rest on stdout is redacted', async () => {
    const res = await runShell({ command: node('split.js') }, withKey(KEY43));
    expect(res.text).toContain('ERR');
    expect(res.text).toContain('[key Reins]');
    expect(leaks(res.text, KEY43)).toBeUndefined();
  }, 60_000);

  it('a key split across two chunks of one stream is redacted', async () => {
    const res = await runShell({ command: node('chunk.js') }, withKey(KEY43));
    expect(res.text).toBe('a[key Reins]b\nexit 0');
  }, 60_000);

  it('output is not held back for ever: it ends with the held-back start of a key, flushed at the end', async () => {
    const res = await runShell({ command: node('pre.js') }, withKey(KEY43));
    expect(res.text).toBe(`abc${KEY43.slice(0, 20)}\nexit 0`);
  }, 60_000);
});

describe('a call does not hang', () => {
  it('a background child that keeps the pipes open does not hold the call: it ends about 200 ms after the shell exits, and the child lives on', async () => {
    const file = path.join(tmp, 'bg.pid');
    let pid = 0;
    try {
      const running = runShell({ command: node('bg.js', `'${file}'`) }, ctxOf());
      let exitedAt = 0;
      spawned[0]!.child.on('exit', () => { exitedAt = Date.now(); });
      const res = await running;
      const returnedAt = Date.now();
      pid = (await pidsFrom(file))[0]!;
      expect(res.text.endsWith('exit 0')).toBe(true);
      // The grandchild still holds the pipes, so the call ended by the drain deadline and not by the close event.
      expect(alive(pid)).toBe(true);
      expect(exitedAt).toBeGreaterThan(0);
      // The drain is 200 ms (written as a number here on purpose, so changing the source turns this red).
      expect(returnedAt - exitedAt).toBeGreaterThanOrEqual(150);
      expect(returnedAt - exitedAt).toBeLessThan(450);
    } finally {
      if (pid || fs.existsSync(file)) {
        pid ||= Number(fs.readFileSync(file, 'utf8'));
        try {
          process.kill(pid);
        } catch {
          // already gone
        }
        // The folder is removed next: the child must be gone first, or Windows will not let it go.
        await until(() => !alive(pid), 3000);
      }
    }
  }, 60_000);

  it('a command that reads stdin gets an end of input at once', async () => {
    const res = await runShell({ command: win ? '$l = [Console]::In.ReadLine(); "got:[$l]"' : 'cat; echo done', timeout: 30 }, ctxOf());
    expect(res.text).not.toContain('timed out');
    expect(res.text).toMatch(win ? /^got:\[\]\r?\nexit 0$/ : /^done\nexit 0$/);
  }, 60_000);

  it.each(['stdout', 'stderr'] as const)('an error on the %s pipe ends the call with a plain result, once, and stops the command', async (which) => {
    const file = path.join(tmp, 'pids.txt');
    const running = runShell({ command: node('tree.js', `'${file}'`), timeout: 30 }, ctxOf({ redactAll: (t) => t.replace('boom', '[hidden]') }));
    const pids = await pidsFrom(file);
    spawned[0]!.child[which].emit('error', new Error('boom'));
    const res = await running;
    expect(res.isError).toBe(true);
    expect(res.text).toBe('The output of the command could not be read: [hidden]');
    expect(await until(() => pids.every((p) => !alive(p)), 2000)).toBe(true);
  }, 60_000);
});

describe('through the engine', () => {
  const rigs: Rig[] = [];
  afterEach(async () => {
    for (const r of rigs.splice(0)) await r.cleanup();
  });
  const make = async (o: Parameters<typeof rig>[1] = {}) => {
    const r = await rig('openai-chat', { strictPairs: true, ...o });
    rigs.push(r);
    return r;
  };
  const call = (id: string, name: string, args: unknown) => ({ id, name, args: JSON.stringify(args) });
  const go = async (r: Rig, policy: Policy, ...c: Array<ReturnType<typeof call>>) => {
    r.push({ toolCalls: c }, { text: 'ok' });
    const s = await r.open({ cwd, policy: () => policy });
    const res = await s.turn('go');
    return { res, said: toolResults(r.fake.requests[1]!.body).map((x) => x.content) };
  };
  const ofType = <T extends EngineEvent['type']>(ev: EngineEvent[], type: T) => ev.filter((e): e is Extract<EngineEvent, { type: T }> => e.type === type);

  it('a shell call ends with the cannot-ask words, after every check, and nothing is spawned', async () => {
    const r = await make();
    const { said } = await go(r, WRITE_MODE, call('a', SHELL, { command: 'echo hi' }));
    expect(said).toEqual([CANNOT_ASK]);
    expect(spawned).toHaveLength(0);
  });

  it('the policy answers before "cannot ask": a read-only step says read-only', async () => {
    const r = await make();
    const { said } = await go(r, { mode: 'read-only', guards: [], allowShell: false }, call('a', SHELL, { command: 'echo hi' }));
    expect(said[0]).toContain('this step is read-only, so shell commands are blocked');
    expect(spawned).toHaveLength(0);
  });

  it('a command naming the Reins home gets the scan words, the refusal events, and no spawn', async () => {
    const r = await make();
    const { res, said } = await go(r, WRITE_MODE, call('a', SHELL, { command: `cat ${r.host.home}${win ? '\\' : '/'}secrets.json` }));
    expect(said).toEqual([HOME_NAMED_WORDS]);
    expect(ofType(res.events!, 'refusal').map((e) => e.reason)).toEqual([HOME_NAMED_WORDS]);
    expect(res.events).toContainEqual({ type: 'hook', event: 'pre-tool', tool: SHELL, decision: 'deny', reason: HOME_NAMED_WORDS });
    expect(spawned).toHaveLength(0);
  });

  it('the scan words are used for the plain mentions, whatever the platform', async () => {
    const r = await make();
    const { said } = await go(r, WRITE_MODE, call('a', SHELL, { command: 'cat ~/.reins/secrets.json' }), call('b', SHELL, { command: 'echo $REINS_HOME' }));
    expect(said).toEqual([HOME_NAMED_WORDS, HOME_NAMED_WORDS]);
  });

  it.each([
    ['win32', 'Bash', 'Read, Write, Edit, Glob, Grep, PowerShell'],
    ['linux', 'PowerShell', 'Read, Write, Edit, Glob, Grep, Bash'],
    ['darwin', 'PowerShell', 'Read, Write, Edit, Glob, Grep, Bash'],
  ] as const)('on %s a %s call is an unknown tool', async (platform, name, list) => {
    const r = await make({ deps: { platform } });
    const { res, said } = await go(r, WRITE_MODE, call('a', name, { command: 'echo hi' }));
    expect(said).toEqual([`Reins has no tool ${name}; use one of: ${list}.`]);
    expect(ofType(res.events!, 'refusal')).toHaveLength(1);
    expect(spawned).toHaveLength(0);
    // The request offered the other shell.
    const offered = (r.fake.requests[0]!.body.tools as Array<{ function?: { name: string }; name?: string }>).map((x) => x.function?.name ?? x.name);
    expect(offered).toEqual(list.split(', '));
  });

  it('the other platform\'s shell tool refuses to run even when called directly', async () => {
    const other = findTool(win ? 'Bash' : 'PowerShell')!;
    const res = await other.run!({ command: 'echo hi' }, { ...ctxOf(), home: path.join(tmp, 'home'), policy: () => WRITE_MODE }, { abs: cwd, root: cwd });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/^Reins has no tool (Bash|PowerShell); use one of: /);
    expect(spawned).toHaveLength(0);
  });

  it('a model that works without tools is offered none, and a shell call is "no tool"', async () => {
    const r = await make({ manifest: { models: [{ id: 'm', context: 1000, maxOutput: 100, tools: false }] } });
    const { said } = await go(r, WRITE_MODE, call('a', SHELL, { command: 'echo hi' }));
    expect(said).toEqual([`Reins has no tool ${SHELL}; this model works without tools.`]);
    expect(r.fake.requests[0]!.body.tools).toBeUndefined();
  });
});

// Added by the orchestrator after the break round (survivors of two one-line edits).
describe('survivors of the break round', () => {
  it('the word-scan patterns fold case where the file system does (win32, darwin) and only there', () => {
    const win = { home: 'C:\\Users\\Zed\\.reins', platform: 'win32' as const };
    const mac = { home: '/Users/zed/.reins', platform: 'darwin' as const };
    const lin = { home: '/home/zed/.reins', platform: 'linux' as const };
    for (const c of ['ls .REINS', 'cat .Reins/x', 'ls SECRET?.json', 'ls Secrets*']) {
      expect(namesHome(c, win), `win32: ${c}`).toBe(true);
      expect(namesHome(c, mac), `darwin: ${c}`).toBe(true);
      expect(namesHome(c, lin), `linux: ${c}`).toBe(false);
    }
  });

  it('the production host hands out a stream redactor that holds back a key split across two chunks', async () => {
    const h = tempHome();
    try {
      const key = 'sk-prod-stream-0123456789abcdef';
      setKey(h.home, 'p', key);
      const mods = await startMods({ dir: h.home, env: {} });
      try {
        const red = hostSend(mods, { env: {}, home: h.home }).redactStream!();
        const out = red.push(`before ${key.slice(0, 12)}`) + red.push(`${key.slice(12)} after`) + red.end();
        expect(out).not.toContain(key.slice(0, 8));
        expect(out).toBe('before [key Reins] after');
      } finally {
        mods.dispose();
      }
    } finally {
      h.cleanup();
    }
  });
});
