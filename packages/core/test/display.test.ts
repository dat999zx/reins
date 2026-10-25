// showText / hasHiddenChars: the one escape for text that somebody else wrote and a person reads before deciding. Built from code points, so this
// file holds none of the characters it tests.
import { describe, expect, it } from 'vitest';
import { hasHiddenChars, showText } from '../src/display.js';

const ch = (n: number) => String.fromCodePoint(n);

describe('showText', () => {
  it('writes every hidden range out as <U+XXXX>', () => {
    const edges: Array<[number, string]> = [
      [0x00, '0000'], [0x1f, '001F'], [0x7f, '007F'], [0x9f, '009F'], [0x61c, '061C'], [0x200b, '200B'], [0x200f, '200F'],
      [0x2028, '2028'], [0x202e, '202E'], [0x2060, '2060'], [0x2064, '2064'], [0x2066, '2066'], [0x2069, '2069'], [0xfeff, 'FEFF'],
    ];
    for (const [code, hex] of edges) {
      expect(showText(`<${ch(code)}>`)).toBe(`<<U+${hex}>>`);
      expect(hasHiddenChars(ch(code))).toBe(true);
    }
  });

  it('also hides the default-ignorable characters that are not controls or format characters', () => {
    for (const code of [0x34f, 0x115f, 0x1160, 0x17b4, 0x180b, 0x180d, 0x3164, 0xfe00, 0xfe0f, 0xffa0, 0xe0100, 0xe0001, 0xe007f]) {
      expect(hasHiddenChars(ch(code))).toBe(true);
      expect(showText(`a${ch(code)}b`)).toMatch(/^a<U\+[0-9A-F]{4,5}>b$/);
    }
  });

  it('does not touch the characters just outside those ranges', () => {
    for (const code of [0x20, 0x7e, 0xa0, 0x61b, 0x61d, 0x200a, 0x2010, 0x2027, 0x202f, 0x205f, 0xfefe, 0xff00]) {
      expect(showText(ch(code))).toBe(ch(code));
      expect(hasHiddenChars(ch(code))).toBe(false);
    }
  });

  it('a line break and a tab: markers on one line, or as they are with lines', () => {
    expect(showText('a\r\nb\tc')).toBe('a<U+000D>\\nb\\tc');
    expect(showText('a\nb\tc', { lines: true })).toBe('a\nb\tc');
  });

  it('is idempotent: its own output holds nothing left to escape', () => {
    const once = showText(`x${ch(0x202e)}y${ch(0x0)}z\n`);
    expect(showText(once)).toBe(once);
  });
});
