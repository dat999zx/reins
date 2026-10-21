// Milestone P, Task 29 phase A, fix round, item 6 (and the end-of-stream nit of item 10): every invisible or default-ignorable code point is written out
// by the one escape, on every surface that shows text a person decides on. The odd characters are built from their code points.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEngine, hasHiddenChars, showText } from '@reins/core';
import { main } from '../src/cli.js';
import { listModels } from '../src/models.js';
import { startRunCli } from '../src/run-cli.js';
import { HELD_MARKER, Redactor, StreamRedactor } from '../src/secrets.js';
import { openStore } from '../src/store.js';

const ch = (n: number) => String.fromCodePoint(n);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

let tmp = '';
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p29a2-display-'))); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe('showText covers every invisible and default-ignorable code point', () => {
  // The list of the review, edge to edge, plus the spots in between.
  const codes = [
    0xad, 0x34f, 0x61c, 0x115f, 0x1160, 0x17b4, 0x17b5, ...range(0x180b, 0x180f), ...range(0x200b, 0x200f), ...range(0x2028, 0x202e),
    ...range(0x2060, 0x206f), 0x3164, ...range(0xfe00, 0xfe0f), 0xfeff, 0xffa0, ...range(0xfff0, 0xfff8), ...range(0x1bca0, 0x1bca3),
    ...range(0x1d173, 0x1d17a), 0xe0000, 0xe0001, 0xe0020, 0xe007f, 0xe0100, 0xe01ef, 0xe0fff, ...range(0, 31), ...range(0x7f, 0x9f),
  ];
  it.each(codes.map((c) => [`U+${hex(c)}`, c] as const))('%s is written out', (_n, c) => {
    const shown = showText(`a${ch(c)}b`, { lines: false });
    expect(shown).not.toContain(ch(c));
    expect(hasHiddenChars(`a${ch(c)}b`)).toBe(true);
    if (c !== 0x0a && c !== 0x09) expect(shown).toBe(`a<U+${hex(c)}>b`);
  });

  it('a lone surrogate is written out; a real pair (an emoji) is not', () => {
    expect(showText(`a${String.fromCharCode(0xd800)}b`)).toBe('a<U+D800>b');
    expect(showText(`a${String.fromCharCode(0xdc00)}b`)).toBe('a<U+DC00>b');
    expect(showText(ch(0x1f600))).toBe(ch(0x1f600));
  });

  it('ordinary text of other scripts, accents and emoji is untouched', () => {
    const t = `caf${ch(0xe9)} ${ch(0x65e5)}${ch(0x672c)}${ch(0x8a9e)} ${ch(0x41f)}${ch(0x440)}${ch(0x438)}${ch(0x432)}${ch(0x435)}${ch(0x442)} ${ch(0x1f680)}`;
    expect(showText(t)).toBe(t);
    expect(hasHiddenChars(t)).toBe(false);
  });
});

describe('the CLI diagnostics go through it', () => {
  it('a path with a direction control is printed written out, never raw', async () => {
    const odd = ch(0x202e);
    const file = path.join(tmp, `w${odd}.reins.md`);
    fs.writeFileSync(file, '---\nreins: 1\nname: a\nbudget: { turns: 5, minutes: 5 }\n---\n\n## phase one\n> Do it.\n');
    const stdout = new PassThrough();
    let text = '';
    stdout.on('data', (d) => (text += d));
    const code = await main(['check', file], { stdout, stderr: new PassThrough(), stdin: new PassThrough(), env: { ...process.env, REINS_HOME: tmp } });
    expect(code).toBe(0);
    expect(text).toContain('w<U+202E>.reins.md');
    expect(text).not.toContain(odd);
  }, 30_000);
});

describe('the picker', () => {
  it('a catalog label is written out and a catalog id with a hidden character is not listed', () => {
    const odd = ch(0x202e);
    const catalog = [
      { id: 'fine-1', label: `Fine${odd}One`, toolCall: true },
      { id: `evil${ch(0xad)}id`, label: 'Evil', toolCall: true },
    ];
    const list = listModels({ models: [{ id: 'own', label: 'Own' }] }, catalog as never, 10, []);
    expect(list.map((m) => m.id)).toEqual(['own', 'fine-1']);
    expect(list[1]!.label).toBe('Fine<U+202E>One');
  });
});

describe('the terminal prints the complete detail of every approval of an engine that Reins runs', () => {
  async function terminal(fullDetail: boolean | undefined) {
    const file = path.join(tmp, 'a.reins.md');
    fs.writeFileSync(file, '---\nreins: 1\nname: a\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n## phase one\n> Do it.\n');
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    let answered = false;
    output.setEncoding('utf8');
    output.on('data', (d: string) => {
      text += d;
      if (!answered && /\[y \/ n <reason>\]/.test(text)) { answered = true; input.write('n\n'); }
    });
    const h = startRunCli({
      file, cwd: tmp, input, output, store: openStore(':memory:'), ...(fullDetail !== undefined ? { fullDetail } : {}),
      makeEngine: ({ onApprove }) => new FakeEngine([{ text: 'done', hold: async () => { await onApprove({ tool: 'Write', input: { file_path: 'a.txt', content: 'SECRET-PAYLOAD-TEXT' } }); } }]),
    });
    await h.done;
    return text;
  }

  it('a short Write pathname does not hide its content', async () => {
    expect(await terminal(true)).toContain('SECRET-PAYLOAD-TEXT');
  });

  it('the CLI engine keeps its recorded transcript: no detail line when the prompt is whole', async () => {
    expect(await terminal(undefined)).not.toContain('SECRET-PAYLOAD-TEXT');
  });
});

describe('item 10 nit: the end of a stream hides every nonempty held start of a key', () => {
  const key = new Redactor({ home: os.tmpdir(), env: { K_API_KEY: 'sk-test-0123456789abcdef' }, keyEnvNames: () => ['K_API_KEY'] });
  it.each([['one character', 's'], ['two', 'sk'], ['three', 'sk-'], ['twelve', 'sk-test-0123']])('%s', (_n, held) => {
    const s = new StreamRedactor(key);
    const out = s.push(`done ${held}`) + s.end();
    expect(out).toBe(`done ${HELD_MARKER}`);
  });
  it('text that does not end on a key start is untouched', () => {
    const s = new StreamRedactor(key);
    expect(s.push('all tests passed\n') + s.end()).toBe('all tests passed\n');
  });
});
