// Milestone P, Task 29 phase D10: tests for the six one-line edits that the last review predicted would leave the suite green.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Policy } from '@reins/core';
import { nonceOf } from '../src/cards.js';
import { generationOf } from '../src/engines.js';
import { createLiveModels } from '../src/live-models.js';
import { confine } from '../src/loop/paths.js';
import { findTool, type ToolCtx } from '../src/loop/tools.js';
import { MAX_CALL_MS, MAX_REPLY } from '../src/loop/wire-util.js';

const KEY = 'sk-test-0123456789abcdef';
const WRITE_MODE: Policy = { mode: 'write', guards: [], allowShell: true };
const REFUSED = 'That content holds a saved key, so it was not written.';

let tmp = '';
beforeEach(() => { tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p29d-surv-'))); });
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('tools.ts: a name is refused when the key is only in the path it resolves to', () => {
  it('the project folder holds the key; the path the model gave does not', async () => {
    const cwd = path.join(tmp, `proj-${KEY}`);
    fs.mkdirSync(cwd);
    const ctx: ToolCtx = {
      cwd, home: path.join(tmp, 'home'), policy: () => WRITE_MODE, signal: new AbortController().signal, redact: (t) => t, redactAll: (t) => t,
      platform: process.platform, holdsSecret: (t) => t.includes(KEY),
    };
    const input = { file_path: 'plain.txt', content: 'hello' };
    expect(input.file_path.includes(KEY)).toBe(false);
    const at = confine(input.file_path, { cwd: ctx.cwd, home: ctx.home, platform: ctx.platform });
    if (!at.ok) throw new Error(at.reason);
    const out = await findTool('Write')!.run!(input, ctx, { abs: at.abs, root: at.root });
    expect(out.isError).toBe(true);
    expect(out.text).toBe(REFUSED);
    expect(fs.existsSync(path.join(cwd, 'plain.txt'))).toBe(false);
  });
});

describe('engines.ts: the generation of a manifest does not depend on the order of keys, inside arrays too', () => {
  const a = { id: 'p', models: [{ id: 'm', price: { input: 1, output: 2 }, context: 10 }], efforts: [{ id: 'low', body: { a: 1, b: 2 } }] };
  const b = { efforts: [{ body: { b: 2, a: 1 }, id: 'low' }], models: [{ context: 10, price: { output: 2, input: 1 }, id: 'm' }], id: 'p' };
  it('the same manifest with its keys reordered has the same generation; a changed price does not', () => {
    expect(generationOf(a as never)).toBe(generationOf(b as never));
    const priced = { ...a, models: [{ id: 'm', price: { input: 1, output: 3 }, context: 10 }] };
    expect(generationOf(priced as never)).not.toBe(generationOf(a as never));
  });
});

describe('cards.ts: two starts that make the card key together keep the first file\'s key', () => {
  it('the loser of the race reads the winner\'s key, not its own', () => {
    const home = path.join(tmp, 'race-home');
    const winner = Buffer.alloc(32, 7);
    const real = fs.writeFileSync;
    let raced = false;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, o?: fs.WriteFileOptions) => {
      if (!raced && String(file).endsWith('card-key')) {
        raced = true;
        real(file, winner.toString('hex'), { mode: 0o600 }); // the other process wrote first
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      }
      return real(file, data, o);
    }) as typeof fs.writeFileSync);
    const got = nonceOf(home, 'conversation-1');
    expect(raced).toBe(true);
    expect(got).toBe(createHmac('sha256', winner).update('conversation-1').digest('hex').slice(0, 32));
  });
});

describe('wire-util.ts: the production limits of one reply', () => {
  it('4 MiB of reply and 30 minutes of time', () => {
    expect(MAX_REPLY).toBe(4 * 1024 * 1024);
    expect(MAX_CALL_MS).toBe(30 * 60_000);
  });
});

describe('live-models.ts: an old answer does not clear the request of a newer generation', () => {
  it('while generation 2 is pending, generation 1 finishing leaves its request in place: a third refresh joins it', async () => {
    let version = 'v1';
    const calls: Array<() => void> = [];
    const live = createLiveModels({
      fetchIds: () => new Promise<string[]>((resolve) => { calls.push(() => resolve(['m'])); }),
      keyless: () => true, consented: () => true, version: () => version,
    });
    const first = live.refresh('p');
    version = 'v2';
    const second = live.refresh('p');
    expect(calls).toHaveLength(2);
    calls[0]!();   // the old one comes back while the new one is still out
    await first;
    const third = live.refresh('p');
    expect(calls).toHaveLength(2);   // joined the pending one; a deleted entry would start a third request
    calls[1]!();
    await Promise.all([second, third]);
    expect(live.ids('p')).toEqual(['m']);
  });
});
