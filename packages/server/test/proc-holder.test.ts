// M9 T7: a workflow command runs under a detached holder, so a hard kill of the server leaves no process behind. Plain processes, no boot.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { until } from './helpers.js';
import { loopTmp } from './loop-harness.js';

const spawned = vi.hoisted(() => [] as Array<{ command: string; args: string[]; opts: { detached?: boolean; stdio?: unknown[] } }>);
vi.mock('node:child_process', async (orig) => {
  const m = await orig<typeof import('node:child_process')>();
  return {
    ...m,
    spawn: ((command: string, ...rest: unknown[]) => {
      const args = rest.find(Array.isArray) as string[] | undefined;
      const opts = rest.find((r) => r && typeof r === 'object' && !Array.isArray(r)) as { detached?: boolean; stdio?: unknown[] } | undefined;
      spawned.push({ command, args: args ?? [], opts: opts ?? {} });
      return (m.spawn as (...a: unknown[]) => unknown)(command, ...rest);
    }) as typeof m.spawn,
  };
});

const { runCommand } = await import('../src/commands.js');
const { HOLDER } = await import('../src/proc.js');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* scratch */ }
  }
});

/** A folder with child.mjs: it writes its pid to the file named in argv[2], then stays alive. */
function fixture() {
  const dir = loopTmp('proc-holder-');
  dirs.push(dir);
  const child = path.join(dir, 'child.mjs');
  fs.writeFileSync(child, 'import fs from "node:fs"; fs.writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);');
  const pidFile = path.join(dir, 'pid.txt');
  const cmd = `"${process.execPath}" "${child}" "${pidFile}"`;
  const pid = () => Number(fs.readFileSync(pidFile, 'utf8'));
  const waitPid = async () => { await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0, 20_000); return pid(); };
  return { dir, cmd, waitPid };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A server stand-in: it starts the holder exactly as runCommand does, then is killed hard. */
async function hardKill(cmd: string, waitPid: () => Promise<number>) {
  const script = `const { spawn } = require('child_process'); const c = spawn(process.execPath, ['-e', ${JSON.stringify(HOLDER)}, '--', ${JSON.stringify(cmd)}], { detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); c.stdin.on('error', () => {}); setInterval(() => {}, 1000);`;
  const fake = spawn(process.execPath, ['-e', script], { stdio: 'ignore', windowsHide: true });
  const pid = await waitPid();
  expect(alive(pid)).toBe(true);
  fake.kill('SIGKILL');
  await until(() => !alive(pid), 10_000);
}

describe('the holder', () => {
  it('ends the command when the server is killed hard', async () => {
    const f = fixture();
    await hardKill(f.cmd, f.waitPid);
  }, 30_000);

  it('ends it when the shell is a parent of the command', async () => {
    const f = fixture();
    await hardKill(`${f.cmd} && echo next`, f.waitPid);
  }, 30_000);

  it('runCommand starts the holder: node -e, detached, stdin a pipe', async () => {
    spawned.length = 0;
    await runCommand('echo hi', { cwd: process.cwd() });
    const s = spawned.find((x) => x.command === process.execPath);
    expect(s).toBeDefined();
    expect(s!.args[0]).toBe('-e');
    expect(s!.opts.detached).toBe(true);
    expect(s!.opts.stdio?.[0]).toBe('pipe');
  });

  it('a timeout ends the command', async () => {
    const f = fixture();
    const p = runCommand(f.cmd, { cwd: f.dir, timeoutMs: 6000 });
    const pid = await f.waitPid();
    expect((await p).stdout).toContain('timed out');
    await until(() => !alive(pid), 10_000);
  }, 30_000);

  it('an abort ends the command', async () => {
    const f = fixture();
    const ac = new AbortController();
    const p = runCommand(f.cmd, { cwd: f.dir, signal: ac.signal });
    const pid = await f.waitPid();
    ac.abort();
    await p;
    await until(() => !alive(pid), 10_000);
  }, 30_000);

  // The CI race (M9): an abort that lands while the holder is still starting its shell. Killing the holder's tree from the server missed
  // the shell, which then held the output pipe open, so runCommand (and a server stop) waited for ever. Seen locally 1 in 39 at 10 ms.
  it('an abort right after the start always ends the call, at any moment', async () => {
    for (const delay of [0, 2, 5, 10, 10, 15, 20, 30, 50, 80]) {
      const ac = new AbortController();
      const p = runCommand('node -e "setTimeout(()=>{},60000)"', { cwd: process.cwd(), signal: ac.signal });
      setTimeout(() => ac.abort(), delay);
      const r = await Promise.race([p.then(() => 'ended'), new Promise((res) => setTimeout(() => res('hung'), 8000))]);
      expect(r, `abort after ${delay} ms`).toBe('ended');
    }
  }, 120_000);

  it('a command that starts with a dash reaches the shell, not node', async () => {
    const r = await runCommand('--version', { cwd: process.cwd() });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain(process.version);
  });
});
