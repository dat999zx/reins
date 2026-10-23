// Milestone P, Task 29 phase D1: keys are hidden on the ORIGINAL text, before it is escaped, cut or indented. A key that holds a soft hyphen or a
// zero-width character would otherwise be written out as <U+00AD> and no longer match the redactor. The odd characters are built from their code points.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEngine } from '@reins/core';
import { main } from '../src/cli.js';
import { askTool, type Question } from '../src/drive.js';
import { startRunCli } from '../src/run-cli.js';
import { Redactor } from '../src/secrets.js';
import { openSession } from '../src/session.js';
import { openStore } from '../src/store.js';
import { testEngine } from './test-engine.js';
import { usePack } from './pack-helper.js';

usePack(); // M3 Task 3: the built-in kinds are the default pack's mods; this file loads the pack once

const ch = (n: number) => String.fromCodePoint(n);
const KEY = `SYNTHETIC_${ch(0xad)}KEY${ch(0x200b)}_0123456789`;
const SHOWN = ['<U+00AD>', '<U+200B>'];
const redactor = (home: string) => new Redactor({ home, env: { X_API_KEY: KEY }, keyEnvNames: () => ['X_API_KEY'] });
const clean = (t: string) => {
  expect(t).not.toContain('SYNTHETIC_');
  expect(t).not.toContain('0123456789');
  expect(t).not.toContain(ch(0xad));
  expect(t).not.toContain(ch(0x200b));
};

let tmp = '';
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p29d-display-'))); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe('the CLI output', () => {
  it('a known key with hidden characters inside a printed path is hidden, not written out', async () => {
    fs.mkdirSync(path.join(tmp, '.reins', 'mods', 'keyed'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.reins', 'mods', 'keyed', 'mod.json'), JSON.stringify({
      reins: 1, id: 'keyed', kind: 'provider', version: '1.0.0', label: 'Keyed', protocol: 'claude-code-cli', baseUrl: 'https://example.com',
      auth: { style: 'bearer', keyEnv: ['X_API_KEY'] }, defaultModel: 'm', models: [{ id: 'm' }],
    }));
    const file = path.join(tmp, `${KEY}.reins.md`);
    fs.writeFileSync(file, '---\nreins: 1\nname: a\nbudget: { turns: 5, minutes: 5 }\n---\n\n## phase one\n> Do it.\n');
    const stdout = new PassThrough();
    let text = '';
    stdout.on('data', (d) => (text += d));
    await main(['check', file], { stdout, stderr: new PassThrough(), stdin: new PassThrough(), env: { ...process.env, REINS_HOME: tmp, X_API_KEY: KEY } });
    expect(text).toContain('[key X_API_KEY]');
    clean(text);
  }, 30_000);
});

describe('reins run', () => {
  it('an approval of a command that holds the key prints it hidden, in the line and under it', async () => {
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
      file, cwd: tmp, input, output, store: openStore(':memory:'), fullDetail: true, redactor: redactor(tmp),
      makeEngine: ({ onApprove }) => new FakeEngine([{ text: 'done', hold: async () => { await onApprove({ tool: 'Bash', input: { command: `echo ${KEY}` } }); } }]),
    });
    await h.done;
    expect(text).toContain('[key X_API_KEY]');
    clean(text);
  });

  it('a key that straddles the 200-character cut of the line is hidden whole', async () => {
    const seen: Question[] = [];
    const r = redactor(tmp);
    const command = `${'x'.repeat(190)}${KEY}`;
    await askTool({ ask: async (q) => { seen.push(q); return 'n'; }, say() {}, write() {}, redact: r.redact }, { tool: 'Bash', input: { command } });
    clean(seen[0]!.prompt);
    expect(seen[0]!.prompt).toContain('[key X_API');   // the marker itself is cut by the line
  });
});

describe('the app: the logged question', () => {
  it('the prompt and the detail of an approval hide the key and hold no raw hidden character', async () => {
    const store = openStore(':memory:');
    const t = testEngine([{ tools: [{ tool: 'Bash', input: { command: `echo ${KEY}` }, approve: true }] }]);
    const row = store.createSession({ id: 's1', cwd: tmp, engine: 'claude-code' });
    const s = openSession({ store, makeEngine: t.makeEngine, folderTrust: t.folderTrust, dir: tmp, redactor: redactor(tmp) }, row, true);
    s.message('go');
    for (let i = 0; i < 600 && !store.readLog('s1').some((r) => r.type === 'question'); i++) await new Promise((r) => setTimeout(r, 5));
    const q = store.readLog('s1').find((r) => r.type === 'question')!.data as Question;
    s.answer(q.id, 'n');
    await s.idle();
    await s.shutdown();
    expect(q.prompt).toContain('[key X_API_KEY]');
    clean(q.prompt);
    clean(q.detail!);
    for (const w of SHOWN) expect(`${q.prompt}${q.detail}`).not.toContain(w);
  });
});
