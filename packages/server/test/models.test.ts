import { describe, it, expect } from 'vitest';
import type { CatalogModel } from '../src/catalog.js';
import { listModels } from '../src/models.js';

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
