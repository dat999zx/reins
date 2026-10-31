// Milestone P, Task 29 phase A, fix round, item 5: a helper process (the process-tree kill after a timeout or an abort, the version probe) gets an env
// worked out when IT starts, not the one the command started with; the version probe gets the scrubbed env.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const killed = vi.hoisted(() => [] as Array<NodeJS.ProcessEnv | undefined>);
const spawned = vi.hoisted(() => [] as Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }>);
vi.mock('../src/proc.js', async (orig) => {
  const m = await orig<typeof import('../src/proc.js')>();
  return { ...m, killTree: (pid: number | undefined, env?: NodeJS.ProcessEnv) => { killed.push(env); m.killTree(pid, env); } };
});
vi.mock('node:child_process', async (orig) => {
  const m = await orig<typeof import('node:child_process')>();
  return {
    ...m,
    spawn: ((command: string, ...rest: unknown[]) => {
      const args = rest.find(Array.isArray) as string[] | undefined;
      const opts = rest.find((r) => r && typeof r === 'object' && !Array.isArray(r)) as { env?: NodeJS.ProcessEnv } | undefined;
      spawned.push({ args: args ?? [], env: opts?.env });
      return (m.spawn as (...a: unknown[]) => unknown)(command, ...rest);
    }) as typeof m.spawn,
  };
});

const { runCommand } = await import('../src/commands.js');
const { runShell } = await import('../src/loop/shell.js');
const { probeClaude } = await import('../src/mods/claude-code-cli/engine.js');

const node = JSON.stringify(process.execPath);
beforeEach(() => { killed.length = 0; spawned.length = 0; });

describe('fix 5: helper processes ask for their env when they start', () => {
  // M9: a timeout tells the holder to stop (its stdin closes) and the holder ends its own tree, so the server starts no kill helper and
  // no env is handed to one. The server's own kill (with an env worked out at that moment) is only the fallback for a holder that hangs.
  it('a timed-out workflow command is ended by its holder: the server starts no kill helper', async () => {
    let n = 0;
    const env = () => ({ ...process.env, STARTED: String(++n) });
    const r = await runCommand(`${node} -e "setTimeout(() => {}, 20000)"`, { cwd: process.cwd(), timeoutMs: 400, env });
    expect(r.stdout).toContain('timed out');
    expect(killed).toEqual([]);
    expect(n).toBe(1); // only the command's own start asked for an env
  });

  it('the kill after an abort of the shell tool gets a fresh env', async () => {
    let n = 0;
    const ac = new AbortController();
    const ctx = {
      cwd: process.cwd(), env: () => ({ ...process.env, STARTED: String(++n) }), redactStream: () => ({ push: (t: string) => t, end: () => '' }),
      platform: process.platform, signal: ac.signal, redact: (t: string) => t, redactAll: (t: string) => t,
    };
    const running = runShell({ command: process.platform === 'win32' ? 'Start-Sleep -Seconds 20' : 'sleep 20' }, ctx as never);
    await new Promise((r) => setTimeout(r, 1500));
    ac.abort();
    await running;
    expect(killed.length).toBeGreaterThanOrEqual(1);
    expect(killed[0]!.STARTED).toBe('2');
  }, 30_000);

  it('the version probe is given the scrubbed env; nothing in it names a key variable', async () => {
    const scrubbed = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, KEEP: 'y' };
    await probeClaude(process.execPath, () => scrubbed);
    const version = spawned.find((s) => s.args.includes('--version'));
    expect(version, 'the version probe was started').toBeDefined();
    expect(version!.env).toEqual(scrubbed);
    expect(version!.env).not.toHaveProperty('X_API_KEY');
  }, 60_000);
});
