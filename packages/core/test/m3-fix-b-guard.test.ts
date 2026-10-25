// M3 fix round, group B, item 3 (core half): `builtin` is what the loader sets for the pack's own blocks and for a Customize copy of one. It decides only what a
// block PRINTS (heading text, default id) and, since fix round 2 (E1, N3), that its ops are not fenced. A foreign mod's text is still one capped, visible line, and its ops stay fenced.
import { describe, expect, it } from 'vitest';
import { guardNode, modOfOp } from '../src/guard.js';
import { NODES, type NodeType } from '../src/nodes/index.js';

const LONG = 'x'.repeat(250);
const node = (mod: NodeType['mod']): NodeType => ({
  kind: 'gz', attrs: [], mod,
  heading: { parse: () => true, print: () => ({ text: `gz ${LONG}\t${LONG}`, condInHeading: false }) },
  defaultId: () => LONG,
  compile() {},
  ops: { GZ: { exec: async () => {} } },
});
const printed = (n: NodeType) => n.heading!.print({ id: 's', kind: 'gz' } as never).text;
const idOf = (n: NodeType) => n.defaultId!({ id: 's', kind: 'gz' } as never);

describe('M3 fix B item 7: the core tests register the pack as the loader does', () => {
  it('every pack kind is the guarded copy with the mod mark: id, pack and builtin, frozen', () => {
    for (const k of ['say', 'phase', 'run', 'if', 'playbook']) {
      const n = NODES.get(k)!;
      // The core-copy project marks every block as a Customize copy of it (builtin, no pack): there the mark has no `pack`.
      if (process.env.REINS_PACK_MARK === 'copy') { expect(n.mod, k).toMatchObject({ id: k, builtin: true }); expect(n.mod!.pack, k).toBeUndefined(); }
      else expect(n.mod, k).toMatchObject({ id: k, pack: true, builtin: true });
      expect(Object.isFrozen(n), k).toBe(true);
      expect(Object.isFrozen(n.mod), k).toBe(true);
    }
  });
});

describe('M3 fix B item 3: guardNode and the builtin flag', () => {
  for (const [name, mod] of [['a copy of a built-in', { id: 'gz', events: [], builtin: true as const }], ['the pack itself', { id: 'gz', events: [], pack: true as const }]] as const) {
    it(`${name}: heading text and default id are kept whole`, () => {
      const g = guardNode(node(mod));
      expect(printed(g)).toBe(`gz ${LONG}\t${LONG}`);
      expect(idOf(g)).toBe(LONG);
      expect(g.mod!.builtin).toBe(true);
    });
  }

  it('a mod that is neither is cut to one visible line, and its id to 80 characters', () => {
    const g = guardNode(node({ id: 'gz', events: [] }));
    expect(printed(g)).toMatch(/\.\.\.$/);
    expect(printed(g).length).toBe(203);
    expect(idOf(g)!.length).toBe(83);
    expect(g.mod!.builtin).toBeUndefined();
  });

  it('a hidden character (a tab) is rewritten for a foreign mod and kept for a copy', () => {
    const n = (mod: NodeType['mod']) => ({ ...node(mod), heading: { parse: () => true, print: () => ({ text: 'a\tb', condInHeading: false }) } });
    expect(guardNode(n({ id: 'gz', events: [] })).heading!.print({} as never).text).not.toBe('a\tb');   // shown, not kept
    expect(guardNode(n({ id: 'gz', events: [], builtin: true })).heading!.print({} as never).text).toBe('a\tb');
  });

  it('the flag does not unfence the ops: they are still a mod\'s (`modOfOp`), and it does not make a pack', () => {
    const g = guardNode(node({ id: 'gz', events: [], builtin: true }));
    const info = modOfOp(g.ops!.GZ!)!;
    expect(info.id).toBe('gz');
    expect(info.builtin).toBe(true);
    expect(info.pack).toBeUndefined();
  });
});
