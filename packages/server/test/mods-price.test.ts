// Milestone P, Task 15 fix round (review blocker 2): a manifest price is numbers of 0 or more, and the default price needs input and output.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadMods } from '../src/mods/loader.js';
import { tempHome } from './mods-harness.js';

let h: ReturnType<typeof tempHome>;
let bundledDir: string;
beforeEach(() => {
  h = tempHome();
  bundledDir = path.join(h.home, 'bundled');
  fs.mkdirSync(bundledDir);
});
afterEach(() => h.cleanup());

const provider = (extra: object = {}) => ({
  reins: 1, id: 'acme', kind: 'provider', version: '1.0.0', label: 'acme', protocol: 'openai-chat',
  baseUrl: 'https://api.acme.test/v1', auth: { style: 'bearer', keyEnv: ['ACME_API_KEY'] },
  defaultModel: 'm1', models: [{ id: 'm1' }], ...extra,
});
const problems = async (manifest: unknown, raw?: string) => {
  for (const id of ['anthropic-messages', 'claude-code-cli', 'openai-chat']) {
    fs.mkdirSync(path.join(bundledDir, id), { recursive: true });
    fs.writeFileSync(path.join(bundledDir, id, 'mod.json'), JSON.stringify({ reins: 1, id, kind: 'protocol', version: '1.0.0', label: id }));
  }
  const dir = h.writeMod('acme', manifest);
  if (raw !== undefined) fs.writeFileSync(path.join(dir, 'mod.json'), raw);
  const out = await loadMods({ bundledDir, userDir: h.modsDir, home: h.home, disabled: new Set(), trusted: () => false, env: {} });
  return out.mods.flatMap((m) => m.problems);
};

describe('provider prices', () => {
  it('a default price of { input: 0 } is rejected: the loop needs input and output', async () => {
    expect(await problems(provider({ price: { input: 0 } }))).toEqual(['`acme`: `price.output` is missing; a price needs both input and output.']);
  });

  it('a negative, text or non-finite number is rejected with a plain message', async () => {
    expect(await problems(provider({ price: { input: -1, output: 1 } }))).toEqual(['`acme`: `price.input` must be a number of 0 or more (got -1).']);
    expect(await problems(provider({ price: { input: '1', output: 1 } }))).toHaveLength(1);
    // JSON has no NaN; 1e999 reads as Infinity
    expect(await problems(provider({}), JSON.stringify(provider()).replace('"models"', '"price":{"input":1e999,"output":1},"models"'))).toHaveLength(1);
  });

  it('a price that is not an object is rejected', async () => {
    expect(await problems(provider({ price: 5 }))).toEqual(['`acme`: `price` must be { "input": ..., "output": ... }, numbers of USD per million tokens.']);
  });

  it('0/0 is a price (a local server), and so is one with cache prices', async () => {
    expect(await problems(provider({ price: { input: 0, output: 0 } }))).toEqual([]);
    expect(await problems(provider({ price: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } }))).toEqual([]);
  });

  it('a cache price that is NaN-like is rejected too', async () => {
    expect(await problems(provider({ price: { input: 1, output: 2, cacheWrite: -2 } }))).toEqual(['`acme`: `price.cacheWrite` must be a number of 0 or more (got -2).']);
  });

  it('a model price: input is needed, output may be left out (a CLI table), bad numbers are rejected', async () => {
    expect(await problems(provider({ models: [{ id: 'm1', price: { input: 3, cacheWrite: 6 } }] }))).toEqual([]);
    expect(await problems(provider({ models: [{ id: 'm1', price: { output: 3 } }] }))).toEqual(['`acme`: `models.m1.price.input` is missing; a price needs input.']);
    expect(await problems(provider({ models: [{ id: 'm1', price: { input: -3 } }] }))).toEqual(['`acme`: `models.m1.price.input` must be a number of 0 or more (got -3).']);
  });

  it('cacheWritePerInput must be a number of 0 or more', async () => {
    expect(await problems(provider({ cacheWritePerInput: -1 }))).toHaveLength(1);
    expect(await problems(provider({ cacheWritePerInput: 2 }))).toEqual([]);
  });
});
