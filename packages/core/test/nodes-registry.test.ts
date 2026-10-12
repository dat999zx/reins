import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { NODES } from '../src/index.js';

// turn.ts is a helper (turnInstr), not a node kind.
const files = readdirSync(new URL('../src/nodes/', import.meta.url))
  .filter((f) => f.endsWith('.ts') && !['index.ts', 'turn.ts'].includes(f));

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
