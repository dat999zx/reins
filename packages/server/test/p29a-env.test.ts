// Milestone P, Task 29 phase A3: workflow commands and every helper child get the SAME scrubbed env as the shell tool, worked out when the
// command runs (a provider installed or switched off after a workflow started is seen). Synthetic keys only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Workflow } from '@reins/core';
import { FakeEngine } from '@reins/core';
import { runCommand } from '../src/commands.js';
import { runOptions } from '../src/drive.js';
import { shellEnvFrom, startMods } from '../src/engines.js';
import type { Mods } from '../src/mods/types.js';

const KEY = 'sk-test-0123456789abcdef';
const node = JSON.stringify(process.execPath);
let tmp = '';
let mods: Mods;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p29a-env-'))); });
afterEach(() => {
  mods?.dispose();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const provider = (home: string, id: string, keyEnv: string) => {
  const dir = path.join(home, 'mods', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({
    reins: 1, id, kind: 'provider', version: '1.0.0', label: id, protocol: 'openai-chat', baseUrl: 'https://example.invalid/v1',
    defaultModel: 'm', models: [{ id: 'm' }], auth: { style: 'bearer', keyEnv: [keyEnv] },
  }));
};

describe('A3: one scrubbed env for every child', () => {
  it('a provider that is switched off still loses its key variable (even a short value no redactor would see)', async () => {
    const home = path.join(tmp, '.reins');
    provider(home, 'old', 'OLD_API_KEY');
    fs.writeFileSync(path.join(home, 'disabled-mods.json'), JSON.stringify(['old']));
    mods = await startMods({ dir: home, env: {} });
    expect(mods.mods.find((m) => m.id === 'old')?.enabled).toBe(false);
    const env = shellEnvFrom(mods, { OLD_API_KEY: 'short', KEEP: 'y', REINS_HOME: '/h' }, () => false)();
    expect(env).toEqual({ KEEP: 'y' });
  });

  it('an alias that holds a key value, and a Path that has one inside, are removed', async () => {
    const home = path.join(tmp, '.reins');
    mods = await startMods({ dir: home, env: {} });
    const env = shellEnvFrom(mods, { ALIAS: KEY, Path: `C:\\tools;${KEY}`, KEEP: 'y' }, (t) => t.includes(KEY))();
    expect(env).toEqual({ KEEP: 'y' });
  });

  it('a workflow command sees an env worked out when it runs, so a provider installed after the workflow started is honoured', async () => {
    let installed = false;
    const env = () => ({ ...process.env, ...(installed ? {} : { LATE_API_KEY: 'seen' }) });
    const o = runOptions({ ask: async () => null, say() {}, write() {} }, {
      workflow: {} as Workflow, engine: new FakeEngine(), cwd: tmp, resolveBlock: () => undefined, onEvent() {}, env,
    });
    const print = async () => (await o.commandRunner!(`${node} -e "console.log(process.env.LATE_API_KEY ?? 'none')"`)).stdout.trim();
    expect(await print()).toBe('seen');
    installed = true; // the provider is installed while the run is going: the next command no longer gets the variable
    expect(await print()).toBe('none');
  });

  it('runCommand asks for the env at each start, not before', async () => {
    let calls = 0;
    const r = await runCommand(`${node} -e "console.log(process.env.FROM_CALLBACK)"`, { cwd: tmp, env: () => { calls++; return { ...process.env, FROM_CALLBACK: `n${calls}` }; } });
    expect(r.stdout.trim()).toBe('n1');
    const r2 = await runCommand(`${node} -e "console.log(process.env.FROM_CALLBACK)"`, { cwd: tmp, env: () => { calls++; return { ...process.env, FROM_CALLBACK: `n${calls}` }; } });
    expect(r2.stdout.trim()).toBe('n2');
  });
});
