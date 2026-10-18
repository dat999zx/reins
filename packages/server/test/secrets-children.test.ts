// Spawn sites that do not belong to the Claude CLI child get the cleaned env (spec 8.4). child_process is wrapped so each call's options are seen.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEngine, type Workflow } from '@reins/core';

const calls = vi.hoisted(() => [] as Array<{ fn: string; command: string; env: NodeJS.ProcessEnv | undefined }>);
vi.mock('node:child_process', async (orig) => {
  const m = await orig<typeof import('node:child_process')>();
  const seen = (fn: string) => (command: string, ...rest: unknown[]) => {
    const opts = rest.find((r) => r && typeof r === 'object' && !Array.isArray(r)) as { env?: NodeJS.ProcessEnv } | undefined;
    calls.push({ fn, command, env: opts?.env });
  };
  return {
    ...m,
    spawn: ((command: string, ...rest: unknown[]) => { seen('spawn')(command, ...rest); return (m.spawn as (...a: unknown[]) => unknown)(command, ...rest); }) as typeof m.spawn,
    spawnSync: ((command: string, ...rest: unknown[]) => { seen('spawnSync')(command, ...rest); return (m.spawnSync as (...a: unknown[]) => unknown)(command, ...rest); }) as typeof m.spawnSync,
  };
});

const { runOptions } = await import('../src/drive.js');
const { doctor } = await import('../src/doctor.js');
const { openUrl } = await import('../src/opener.js');
const { pickFolder } = await import('../src/picker.js');
const { killTree } = await import('../src/proc.js');
const { Registry } = await import('../src/mods/registry.js');
const { childEnv } = await import('../src/secrets.js');

const KEY = 'sk-test-0123456789abcdef';
const full = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DISPLAY: ':0', X_API_KEY: KEY, REINS_HOME: '/h' };
const clean = childEnv(full, ['X_API_KEY']);
const noKey = (e: NodeJS.ProcessEnv | undefined) => {
  expect(e, 'the call got no env at all (it inherits everything)').toBeDefined();
  expect(e).not.toHaveProperty('X_API_KEY');
  expect(e).not.toHaveProperty('REINS_HOME');
  expect(e!.PATH).toBe(process.env.PATH);
};

beforeEach(() => { calls.length = 0; });

describe('spawn sites get the cleaned env', () => {
  it('drive.ts: the git calls', async () => {
    const o = runOptions({ ask: async () => null, say() {}, write() {} }, {
      workflow: {} as Workflow, engine: new FakeEngine(), cwd: process.cwd(), resolveBlock: () => undefined, onEvent() {}, env: clean,
    });
    await o.diffLines?.();
    const git = calls.filter((c) => c.command === 'git');
    expect(git.length).toBeGreaterThanOrEqual(1);
    for (const c of git) noKey(c.env);
  });

  it('doctor.ts: the knowl check', async () => {
    const mods = { mods: [], registry: new Registry(), problems: [], dispose() {} };
    mods.registry.register('provider', 'keyed', { manifest: { id: 'keyed', label: 'K', defaultModel: 'm', models: [], auth: { style: 'bearer', keyEnv: ['X_API_KEY'] } } });
    await doctor(() => {}, mods, { env: full, home: process.cwd() });
    const knowl = calls.filter((c) => c.command.startsWith('knowl'));
    expect(knowl).toHaveLength(1);
    noKey(knowl[0]!.env);
  });

  it('picker.ts: the dialog process', async () => {
    await pickFolder(new AbortController().signal, { platform: 'linux', env: clean }).catch(() => {});
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) noKey(c.env);
  });

  it('opener.ts: the browser launcher', () => {
    let seen: NodeJS.ProcessEnv | undefined;
    openUrl(`http://127.0.0.1:1/#token=${'a'.repeat(64)}`, {
      platform: 'win32', dir: process.cwd(), err() {}, env: clean,
      spawn: (_c, _a, options) => { seen = options.env; return { on() { return undefined; }, unref() {} }; },
    });
    noKey(seen);
  });

  it.skipIf(process.platform !== 'win32')('the Claude engine: the taskkill of an interrupt that was not answered (Windows only: elsewhere no helper process is started)', async () => {
    const { claudeEngine } = await import('../src/mods/claude-code-cli/engine.js');
    const { FAKE_CLAUDE, fakeSetup, until } = await import('./helpers.js');
    const f = fakeSetup([{ fixture: 'claude-2.1.281-card-marker-hook.jsonl', ignoreInterrupt: true }], 400);
    const live: Array<{ type: string }> = [];
    const s = await claudeEngine({
      bin: FAKE_CLAUDE, helperEnv: clean, interruptTimeoutMs: 500,
      onApprove: async () => ({ behavior: 'allow' }), onLive: (e) => live.push(e),
    }).open({ cwd: f.dir, policy: () => ({ mode: 'write', guards: [], allowShell: true }) });
    const turn = s.turn('slow');
    await until(() => live.some((e) => e.type === 'tool_call'));
    await s.interrupt();
    await turn;
    await s.close();
    const kill = calls.filter((c) => c.command === 'taskkill');
    expect(kill.length).toBeGreaterThanOrEqual(1);
    for (const c of kill) noKey(c.env);
  }, 30_000);

  it.skipIf(process.platform !== 'win32')('proc.ts: taskkill (Windows only: skipped elsewhere, where no helper process is started)', () => {
    killTree(99999999, clean);
    const kill = calls.filter((c) => c.command === 'taskkill');
    expect(kill).toHaveLength(1);
    noKey(kill[0]!.env);
  });
});
