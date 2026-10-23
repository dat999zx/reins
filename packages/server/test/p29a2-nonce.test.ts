// Milestone P, Task 29 phase A, fix round, items 7 to 10: the card marker of a conversation is the same on every reopen (after 2,000 other
// conversations, after a restart, in the CLI engine too), roots are refused as folders, a key-bearing workflow path is answered before OK, and no second
// Redactor exists beside the process's one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { nonceOf } from '../src/cards.js';
import { claudeEngine } from '../src/mods/claude-code-cli/engine.js';
import { projectFolderWords, TOO_WIDE_WORDS } from '../src/session.js';
import { rig, type Rig } from './loop-harness.js';
import { FAKE_CLAUDE, fakeSetup, until } from './helpers.js';
import { usePack } from './pack-helper.js';

usePack(); // M3 Task 3: the built-in kinds are the default pack's mods; this file loads the pack once

let tmp = '';
const rigs: Rig[] = [];
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p29a2-nonce-'))); });
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('item 10: one card marker per conversation, kept with the Reins folder', () => {
  it('is the same after 2,000 other conversations', () => {
    const first = nonceOf(tmp, 'conversation-0');
    for (let i = 1; i <= 2000; i++) nonceOf(tmp, `conversation-${i}`);
    expect(nonceOf(tmp, 'conversation-0')).toBe(first);
  });

  it('is the same after a restart (the module is loaded again), and differs between conversations and between Reins folders', async () => {
    const first = nonceOf(tmp, 'c1');
    vi.resetModules();
    const again = await import('../src/cards.js');
    expect(again.nonceOf(tmp, 'c1')).toBe(first);
    expect(again.nonceOf(tmp, 'c2')).not.toBe(first);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p29a2-other-'));
    try {
      expect(again.nonceOf(other, 'c1')).not.toBe(first);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });

  it('the loop engine reopens a conversation with the marker it had, after 2,000 other conversations', async () => {
    const r = await rig('openai-chat');
    rigs.push(r);
    const markerOf = async (sessionId?: string) => {
      const s = await r.open(sessionId ? { sessionId } : {});
      r.push({ text: 'ok' });
      await s.turn('hi');
      await s.close();
      const body = r.fake.requests.at(-1)!.body as { messages: unknown };
      return { id: s.sessionId, marker: /REINS CARD ([0-9a-f]+)/.exec(JSON.stringify(body.messages))?.[1] };
    };
    const first = await markerOf();
    for (let i = 0; i < 2000; i++) nonceOf(r.host.home, randomUUID());
    expect((await markerOf(first.id)).marker).toBe(first.marker);
  }, 60_000);

  it('the CLI engine reuses it too: two opens of the same session carry the same marker in the trust note', async () => {
    const f = fakeSetup([]);
    const e = claudeEngine({ bin: FAKE_CLAUDE, home: tmp, onApprove: async () => ({ behavior: 'allow' }), onLive: () => {} });
    const sessionId = randomUUID();
    const a = await e.open({ cwd: f.dir, sessionId, policy: () => ({ mode: 'write', guards: [], allowShell: true }) });
    await until(() => f.log().filter((l) => l.kind === 'args').length === 1);
    await a.close();
    const b = await e.open({ cwd: f.dir, sessionId, policy: () => ({ mode: 'write', guards: [], allowShell: true }) });
    await until(() => f.log().filter((l) => l.kind === 'args').length === 2);
    await b.close();
    const [la, lb] = f.log().filter((l) => l.kind === 'args');
    const nonceA = /\[REINS CARD ([0-9a-f]{32}): /.exec(la.note)![1];
    expect(nonceA).toBe(/\[REINS CARD ([0-9a-f]{32}): /.exec(lb.note)![1]);
    expect(nonceA).toBe(nonceOf(tmp, sessionId));
  }, 30_000);

  it('the marker cannot be worked out from the conversation id alone: the key file is private to the Reins folder', () => {
    nonceOf(tmp, 'c1');
    const file = path.join(tmp, 'card-key');
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
  });
});

describe('item 9: a filesystem root is refused as a session folder, whatever the homes are', () => {
  const home = 'D:\\users\\me';
  const reins = 'D:\\users\\me\\.reins';
  it.each(['C:\\', 'D:\\', 'Z:\\', 'c:/', '\\\\server\\share', '\\\\server\\share\\', '\\\\server', '//server/share'])('refuses %s', (root) => {
    expect(projectFolderWords(root, reins, home)).toBe(TOO_WIDE_WORDS);
  });

  it('accepts a folder on another drive and a folder inside a share', () => {
    expect(projectFolderWords('C:\\work\\proj', reins, home)).toBeUndefined();
    expect(projectFolderWords('\\\\server\\share\\proj', reins, home)).toBeUndefined();
  });

  it('refuses the root of this machine\'s own filesystem', () => {
    expect(projectFolderWords(path.parse(process.cwd()).root, path.join(tmp, '.reins'), path.join(tmp, 'home'))).toBe(TOO_WIDE_WORDS);
  });
});

describe('item 8: the worker is plain too when an identity write is refused after OK (the fallback)', () => {
  it('a KeyInIdentity in the worker is logged as the plain words, not as "Internal error: ..."', async () => {
    const { Redactor, setKey } = await import('../src/secrets.js');
    const { openStore, redactingStore } = await import('../src/store.js');
    const { openSession } = await import('../src/session.js');
    const { testEngine } = await import('./test-engine.js');
    // An earlier test of this file reset the modules, so the core these imports use is a new copy: it gets its own pack (the file's `usePack` filled the old copy).
    const pack = await (await import('./pack-helper.js')).loadPack();
    onTestFinished(() => pack.off());
    const home = path.join(tmp, '.reins');
    const cwd = path.join(tmp, 'proj');
    fs.mkdirSync(cwd);
    const SECRET = 'sk-test-0123456789abcdef';
    setKey(home, 'p', SECRET);
    const store = redactingStore(openStore(':memory:'), new Redactor({ home, env: {}, keyEnvNames: () => [] }));
    const t = testEngine([]);
    const row = store.createSession({ id: 's1', cwd, engine: 'claude-code' });
    // No `redactor` in the deps: the early check is off, so only the worker fallback is under test.
    const s = openSession({ store, makeEngine: t.makeEngine, folderTrust: t.folderTrust, dir: home }, row, true);
    const file = path.join(cwd, `${SECRET}.reins.md`);
    fs.writeFileSync(file, '---\nreins: 1\nname: a\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n## phase one\n> Do it.\n');
    expect(s.runFile(file)).toEqual({ ok: true });
    // The folder of the CLI engine may ask for its trust first: say yes to any open question until the run row is refused.
    const notes = () => store.readLog('s1').filter((r) => r.type === 'note').map((r) => (r.data as { text: string }).text);
    for (let i = 0; i < 1000 && !notes().some((t) => /saved key/.test(t)); i++) {
      const log = store.readLog('s1');
      for (const q of log.filter((r) => r.type === 'question')) {
        const id = (q.data as { id: string }).id;
        if (!log.some((x) => (x.type === 'answer' || x.type === 'question_closed') && (x.data as { questionId?: string }).questionId === id)) s.answer(id, 'y');
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    await s.idle();
    expect(notes()).toContain('That value contains a saved key, so it was not saved.');
    expect(notes().join('\n')).not.toMatch(/Internal error/);
    await s.shutdown();
  }, 30_000);
});

describe('item 7: one Redactor per process', () => {
  const src = (f: string) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  it('only the process owner (cli.ts) and the host fallback for a hand-built host create one', () => {
    const found: string[] = [];
    const walk = (dir: string, rel = '') => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory()) walk(path.join(dir, d.name), `${rel}${d.name}/`);
        else if (d.name.endsWith('.ts') && /new Redactor\(/.test(fs.readFileSync(path.join(dir, d.name), 'utf8'))) found.push(`${rel}${d.name}`);
      }
    };
    walk(fileUrlDir());
    expect(found.sort()).toEqual(['cli.ts', 'engines.ts']);
  });
  it('doctor and serve are given the shared instance', () => {
    expect(src('cli.ts')).toMatch(/doctor\(out, mods, \{[^}]*\}, redactor\)/);
    expect(src('doctor.ts')).toMatch(/probeFrom\(mods, p\.id, host, redactor\)/);
    expect(src('serve.ts')).not.toMatch(/new Redactor/);
  });
});

function fileUrlDir(): string {
  return path.dirname(new URL('../src/cli.ts', import.meta.url).pathname.replace(/^\/([a-z]:)/i, '$1'));
}
