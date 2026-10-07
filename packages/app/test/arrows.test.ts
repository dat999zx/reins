import { describe, expect, it } from 'vitest';
import { parseWorkflow, type Workflow } from '@reins/core';
import { edgeId, type Mark } from '../src/canvas.js';
import { arrowPath, labelAt, labelW, lanes, linksToDraw, placeLabels, type LinkArrow } from '../src/arrows.js';

const text = (links: string) => `---
reins: 1
name: demo
budget: { turns: 10, minutes: 30 }
always: []
---

## phase plan
${links}

## phase build
> Build it.

## repeat
id: r
until: tests pass
max: 3

### run \`npm test\`
id: t
on-fail: plan (max 2)
`;
const parse = (links: string): Workflow => parseWorkflow(text(links)).workflow!;
const none = new Map<string, Mark>();

describe('then arrows', () => {
  const thenOf = (body: string) => linksToDraw(parseWorkflow(`---\nreins: 1\nname: demo\nbudget: { turns: 10, minutes: 30 }\nalways: []\n---\n\n${body}`).workflow!, none).then.map((t) => `${t.from}>${t.to}`);
  it('joins consecutive free blocks; none into the first one, none from a block with next', () => {
    expect(thenOf('## phase a\n\n## end\n\n## phase f1\n\n## phase f2\nnext: a\n\n## phase f3\n\n## phase f4\n')).toEqual(['f1>f2', 'f3>f4']);
  });
  it('a free end starts nothing', () => {
    expect(thenOf('## phase a\n\n## end\n\n## phase f1\n\n## end\nid: e2\n\n## phase f3\n')).toEqual(['f1>e2']);
  });
  it('no end, no free blocks, no then', () => {
    expect(thenOf('## phase a\n\n## phase b\n')).toEqual([]);
  });
});

describe('linksToDraw', () => {
  it('keeps every kind, in step order, with the link index', () => {
    const { arrows } = linksToDraw(parse('next: build\nretry: build'), none);
    expect(arrows.map((a) => [a.from, a.index, a.kind, a.to])).toEqual([
      ['plan', 0, 'next', 'build'], ['plan', 1, 'retry', 'build'], ['t', 0, 'on-fail', 'plan'],
    ]);
  });
  it('finds links inside a C block', () => {
    expect(linksToDraw(parse(''), none).arrows.map((a) => a.from)).toEqual(['t']);
  });
  it('puts a link to a step that does not exist in missing, not in arrows', () => {
    const r = linksToDraw(parse('next: ghost'), none);
    expect(r.arrows.map((a) => a.from)).toEqual(['t']);
    expect(r.missing).toEqual([{ from: 'plan', index: 0, kind: 'next', to: 'ghost' }]);
  });
  it('takes the mark of a link from the wires map, keyed by edgeId', () => {
    const r = linksToDraw(parse('next: build'), new Map<string, Mark>([[edgeId('plan', 0, 'build'), 'error']]));
    expect(r.arrows.find((a) => a.from === 'plan')!.mark).toBe('error');
    expect(r.arrows.find((a) => a.from === 't')!.mark).toBeUndefined();
  });
});

describe('arrowPath', () => {
  const a = { x: 0, y: 0, w: 100, h: 20 };
  it('is an S-curve when the target is more than 40 px to the right', () => {
    const p = arrowPath(a, { x: 200, y: 80, w: 100, h: 20 }, 0);
    expect(p).toMatch(/^M 100 10 C /);
    expect(p).toMatch(/200 90$/);
  });
  it('is a bracket to the right of both otherwise, `24 + 10 * lane` px out', () => {
    const below = { x: 0, y: 60, w: 100, h: 20 };
    const p = arrowPath(a, below, 0);
    expect(p).not.toContain(' C ');
    expect(p).toContain('Q 124 ');
    expect(p).toMatch(/^M 100 10 /);
    expect(p).toMatch(/H 100$/);
    expect(arrowPath(a, below, 1)).toContain('Q 134 ');
  });
  it('goes out past the wider block', () => {
    expect(arrowPath(a, { x: 0, y: 60, w: 160, h: 20 }, 0)).toContain('Q 184 ');
  });
});

describe('labelAt', () => {
  const a = { x: 0, y: 0, w: 100, h: 20 };
  it('sits beside the vertical run of a bracket, in its lane', () => {
    expect(labelAt(a, { x: 0, y: 60, w: 100, h: 20 }, 0)).toEqual({ x: 128, y: 44 });
    expect(labelAt(a, { x: 0, y: 60, w: 100, h: 20 }, 1).x).toBe(138);
  });
  it('sits above the middle of an S-curve', () => {
    expect(labelAt(a, { x: 200, y: 80, w: 100, h: 20 }, 0)).toEqual({ x: 154, y: 46 });
  });
});

describe('placeLabels', () => {
  const at = (k: string, x: number, y: number, t = 'on fail') => ({ key: k, at: { x, y }, text: t });
  const clash = (a: { x: number; y: number }, ta: string, b: { x: number; y: number }, tb: string) =>
    Math.abs(a.x - b.x) < Math.max(labelW(ta), labelW(tb)) && Math.abs(a.y - b.y) < 12;
  it('moves labels that would overprint apart, vertically', () => {
    const m = placeLabels([at('a', 100, 50), at('b', 110, 50, 'retry'), at('c', 100, 52)]);
    const [a, b, c] = ['a', 'b', 'c'].map((k) => m.get(k)!);
    expect(clash(a, 'on fail', b, 'retry')).toBe(false);
    expect(clash(a, 'on fail', c, 'on fail')).toBe(false);
    expect(clash(b, 'retry', c, 'on fail')).toBe(false);
  });
  it('leaves labels that do not touch where they are', () => {
    const m = placeLabels([at('a', 100, 50), at('b', 100, 90), at('c', 400, 50)]);
    expect([m.get('a'), m.get('b'), m.get('c')]).toEqual([{ x: 100, y: 50 }, { x: 100, y: 90 }, { x: 400, y: 50 }]);
  });
});

describe('lanes', () => {
  const order = ['a', 'b', 'c', 'd'];
  const l = (from: string, to: string): LinkArrow => ({ from, index: 0, kind: 'next', to });
  it('gives overlapping vertical spans different lanes', () => {
    const m = lanes([l('a', 'c'), l('b', 'd')], order);
    expect(m.get('a/0')).not.toBe(m.get('b/0'));
  });
  it('treats arrows that share a row as overlapping', () => {
    const m = lanes([l('a', 'b'), l('b', 'c')], order);
    expect(m.get('a/0')).not.toBe(m.get('b/0'));
  });
  it('reuses lane 0 for spans that do not touch, whichever way the arrow points', () => {
    const m = lanes([l('a', 'b'), l('d', 'c')], order);
    expect([m.get('a/0'), m.get('d/0')]).toEqual([0, 0]);
  });
});
