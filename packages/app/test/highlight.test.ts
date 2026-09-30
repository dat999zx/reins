import { describe, it, expect } from 'vitest';
import { highlight, lineOffset } from '../src/highlight.js';

describe('lineOffset', () => {
  it('is the index where a 1-based line starts, clamped to the start', () => {
    expect(lineOffset('ab\ncd\nef', 1)).toBe(0);
    expect(lineOffset('ab\ncd\nef', 3)).toBe(6);
    expect(lineOffset('ab', 0)).toBe(0);
  });
});

const kinds = (text: string) => highlight(text).map((l) => l.spans.map((s) => s.cls).join('+'));

describe('highlight', () => {
  it('numbers lines from 1 and keeps every character', () => {
    const text = '---\nreins: 1\n---\n\n## phase go\n> do it\nuntil: tests pass\nplain\n';
    const lines = highlight(text);
    expect(lines.map((l) => l.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(lines.map((l) => l.spans.map((s) => s.text).join('')).join('\n')).toBe(text);
  });

  it('marks frontmatter, headings, prompt lines, attribute lines and the rest', () => {
    expect(kinds('---\nreins: 1\nname: x\n---\n## phase go\n> do it\nuntil: tests pass\nplain text')).toEqual([
      'fm', 'fm', 'fm', 'fm', 'heading', 'prompt', 'key+value', 'plain',
    ]);
  });

  it('keeps a > line that contains ## x a prompt line', () => {
    expect(kinds('> ## x')).toEqual(['prompt']);
    expect(kinds('  > ## x')).toEqual(['prompt']);
  });

  it('reads a heading of any depth up to six, and not seven', () => {
    expect(kinds('# a\n###### b\n####### c')).toEqual(['heading', 'heading', 'plain']);
  });

  it('treats key: lines inside the frontmatter as frontmatter, and after it as attributes', () => {
    expect(kinds('---\nbudget: { turns: 1 }\n---\nmode: read-only')).toEqual(['fm', 'fm', 'fm', 'key+value']);
  });

  it('leaves an empty line with no spans', () => {
    expect(highlight('\n')[0]!.spans).toEqual([]);
  });
});
