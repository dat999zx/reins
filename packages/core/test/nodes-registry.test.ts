import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { NODES } from '../src/index.js';
import { PACK_DIR, packMods } from './pack.js';

// turn.ts is a helper (turnInstr), fields.ts and *.view.ts are the front side, not node kinds.
const files = readdirSync(new URL('../src/nodes/', import.meta.url))
  .filter((f) => f.endsWith('.ts') && !['index.ts', 'turn.ts', 'fields.ts'].includes(f) && !f.endsWith('.view.ts'));

describe('every nodes/*.ts file is in NODES', () => {
  it('finds the node files', () => {
    expect(files).toContain('model.ts');
  });
  for (const f of files) {
    it(f, async () => {
      const m = await import(`../src/nodes/${f}`);
      expect(NODES.get(m.default.kind), f).toBe(m.default);
    });
  }
});

// M3: the kinds that moved to the default pack are read from the pack's manifests (core's setup registered them with the manifest order).
describe('every default pack block is in NODES at its manifest order', () => {
  const blocks = packMods(PACK_DIR).filter((p) => (p.manifest as { kind?: string }).kind === 'block');
  it('finds the pack blocks', () => {
    expect(blocks.map((b) => b.id)).toEqual(expect.arrayContaining(['say', 'phase', 'end']));
  });
  const ordered = [...NODES.keys()];
  for (const b of blocks) {
    it(b.id, () => {
      const kinds = (b.manifest as { provides: { kinds: string[] } }).provides.kinds;
      for (const k of kinds) expect(NODES.get(k)?.kind, k).toBe(k);
      // against every other pack block: the kinds stand in the order of the manifests
      for (const o of blocks) {
        const a = (b.manifest as { order: number }).order, z = (o.manifest as { order: number }).order;
        if (a < z) expect(ordered.indexOf(kinds[0]!), `${b.id} before ${o.id}`).toBeLessThan(ordered.indexOf((o.manifest as { provides: { kinds: string[] } }).provides.kinds[0]!));
      }
    });
  }
});
