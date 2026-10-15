import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CatalogModel } from '../src/catalog.js';
import { listModels, loadProviders } from '../src/providers.js';

const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('provider discovery', () => {
  it('finds the claude provider in its own folder', async () => {
    const found = await loadProviders();
    const claude = found.find((p) => p.id === 'claude');
    expect(claude?.models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']);
  });

  it('every provider has a default model that is one of its models', async () => {
    const found = await loadProviders();
    expect(found.length).toBeGreaterThan(0);
    for (const p of found) expect(p.models.map((m) => m.id), p.id).toContain(p.defaultModel);
  });

  it('every provider has a default reasoning level that is one of its levels', async () => {
    const found = await loadProviders();
    for (const p of found) expect(p.efforts.map((e) => e.id), p.id).toContain(p.defaultEffort);
    expect(found.find((p) => p.id === 'claude')!.efforts.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
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

describe('listModels', () => {
  const provider = { models: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
  const cm = (id: string, over: Partial<CatalogModel> = {}): CatalogModel => ({ id, label: `Cat ${id}`, toolCall: true, released: '2026-01-01', ...over });
  const catalog = [
    cm('x', { released: '2026-02-01' }), cm('a', { context: 1000 }), cm('y', { released: '2026-03-01' }),
    cm('z-20260101'), cm('t', { toolCall: false }), cm('u', { toolCall: undefined }),
  ];
  it('with no catalog data it is the curated list as it is', () => {
    expect(listModels(provider, [], 8)).toEqual([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]);
  });
  it('curated first in file order (its label wins), then extras newest first; dated ids and non tool-call models are dropped', () => {
    expect(listModels(provider, catalog, 8)).toEqual([
      { id: 'a', label: 'A', window: 1000 }, { id: 'b', label: 'B' }, { id: 'y', label: 'Cat y' }, { id: 'x', label: 'Cat x' },
    ]);
  });
  it('the limit counts the curated models too, and never cuts them', () => {
    expect(listModels(provider, catalog, 3).map((m) => m.id)).toEqual(['a', 'b', 'y']);
    expect(listModels(provider, catalog, 1).map((m) => m.id)).toEqual(['a', 'b']);
  });
});