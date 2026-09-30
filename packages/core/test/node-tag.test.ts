import { describe, it, expect } from 'vitest';
import { NODES } from '../src/index.js';

describe('NodeType.tag (3b.5)', () => {
  it('the initial tags are repeat, gate and verify, with exactly the spec fields', () => {
    expect(NODES.get('repeat')?.tag).toEqual({ place: 'wrap', arg: 'until', argRequired: true, lines: ['max: 5'] });
    expect(NODES.get('gate')?.tag).toEqual({ place: 'after', lines: ['until: you approve'] });
    expect(NODES.get('verify')?.tag).toEqual({ place: 'after', lines: ['against: prompt'] });
  });
  it('no other node has a tag', () => {
    expect([...NODES.values()].filter((n) => n.tag).map((n) => n.kind).sort()).toEqual(['gate', 'repeat', 'verify']);
  });
});
