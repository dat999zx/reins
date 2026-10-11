import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProviders } from '../src/providers.js';

const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('provider discovery', () => {
  it('finds the claude provider in its own folder', async () => {
    const found = await loadProviders();
    const claude = found.find((p) => p.id === 'claude');
    expect(claude?.models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']);
  });

  it('a folder with a provider file is a provider; a folder without one is not', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-prov-'));
    tmps.push(root);
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    fs.mkdirSync(path.join(root, 'acme'));
    fs.mkdirSync(path.join(root, 'other'));
    fs.writeFileSync(path.join(root, 'acme', 'provider.js'),
      "export const provider = { id: 'acme', label: 'Acme', models: [], windows: {}, prices: {}, costAcrossResume: 'per-process' };\n");
    expect((await loadProviders(root)).map((p) => p.id)).toEqual(['acme']);
  });
});
