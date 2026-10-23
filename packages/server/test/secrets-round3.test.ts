// Task 7 fix round 2: what the serializer sees, identity fields, print --write, provider metadata, the file stamp.
// Every key is an obvious fake; nothing touches the network.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { main } from '../src/cli.js';
import { KEY_IN_WORKFLOW, Redactor, setKey } from '../src/secrets.js';
import { KEY_IN_IDENTITY, openStore, redactingStore } from '../src/store.js';
import { boot, cleanup, tmpDir } from './http-helpers.js';
import { tempHome } from './mods-harness.js';
import { usePack } from './pack-helper.js';

const KEY = 'sk-test-0123456789abcdef';
const KEY_B = 'sk-test-fedcba9876543210';
const ISO = new Date(0).toISOString();
afterEach(cleanup);

const redactorFor = (home: string) => new Redactor({ home, env: {}, keyEnvNames: () => [] });

function filesUnder(dir: string): Array<{ file: string; bytes: Buffer }> {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : [{ file: p, bytes: fs.readFileSync(p) }];
  });
}

class Box { constructor(public text: string, public n = 1) {} }

describe('1. what the serializer sees: instances, toJSON, Date', () => {
  it('a class instance, an object with toJSON and a Date holding a key reach no file and read back clean', () => {
    const dir = tmpDir();
    setKey(dir, 'a', KEY);
    setKey(dir, 'b', ISO);                                                     // a key that is the text of a Date
    const store = redactingStore(openStore(path.join(dir, 'reins.db')), redactorFor(dir));
    const data = { inst: new Box(KEY), tj: { toJSON: () => KEY }, when: new Date(0), plain: 'ok', buf: Buffer.from('hi') };
    store.createSession({ id: 's1', cwd: '/c', engine: 'e' });
    store.appendLog('s1', { type: 'note', data });
    store.createRun({ id: 'r1', workflowPath: '/w', cwd: '/c' });
    store.appendEvent('r1', { id: 'e1', timestamp: 1, type: 'x' as never, data: data as never });
    store.putSetting('s', data);
    store.saveSnapshot('r1', { ...data, events: [] } as never);
    for (const f of filesUnder(dir)) {
      if (path.basename(f.file) === 'secrets.json') continue;
      expect(f.bytes.includes(Buffer.from(KEY)), `KEY in ${f.file}`).toBe(false);
      expect(f.bytes.includes(Buffer.from(ISO)), `ISO in ${f.file}`).toBe(false);
    }
    expect(store.readLog('s1')[0]!.data).toEqual({ inst: { text: '[key Reins]', n: 1 }, tj: '[key Reins]', when: '[key Reins]', plain: 'ok', buf: { type: 'Buffer', data: [104, 105] } });
    store.close();
  });

  it('a value that holds no key is returned as it is (a Date stays a Date), with a key known', () => {
    const dir = tmpDir();
    setKey(dir, 'a', KEY);
    const r = redactorFor(dir);
    const when = new Date(5000);
    const out = r.redactJson({ when, box: new Box('fine'), n: 1 });
    expect(out.when).toBe(when);
    expect(out.box).toBeInstanceOf(Box);
  });
});

describe('2. identity fields are refused, not merged', () => {
  it('a write whose id, path, hash, cwd or name holds a key is refused; normal values are unchanged', () => {
    const dir = tmpDir();
    setKey(dir, 'a', KEY);
    setKey(dir, 'b', KEY_B);
    const store = redactingStore(openStore(':memory:'), redactorFor(dir));
    const refused = (f: () => unknown) => expect(f).toThrow(KEY_IN_IDENTITY);
    refused(() => store.trust(`/work/${KEY}`, `/work/${KEY}/w`, 'h'));
    refused(() => store.trust('/work/x', '/work/x/w', `h-${KEY}`));
    refused(() => store.createRun({ id: 'r1', workflowPath: `/w/${KEY}`, cwd: '/c' }));
    refused(() => store.createRun({ id: 'r1', workflowPath: '/w', cwd: `/c/${KEY}` }));
    refused(() => store.createSession({ id: `s-${KEY}`, cwd: '/c', engine: 'e' }));
    refused(() => store.createSession({ id: 's1', cwd: `/c/${KEY}`, engine: 'e' }));
    refused(() => store.createSession({ id: 's1', cwd: '/c', engine: `e-${KEY}` }));
    refused(() => store.putSetting(`name-${KEY}`, 1));
    refused(() => store.putEditorState(`/c/${KEY}`, '{}'));
    refused(() => store.putEngineTotal(`es-${KEY}`, 1));
    refused(() => store.putEngineTotal('es', 1, { [`m-${KEY}`]: 1 }));
    refused(() => store.appendLog(`s-${KEY}`, { type: 'note' }));
    refused(() => store.appendLog('s1', { type: 'note', runId: `r-${KEY}` }));
    refused(() => store.appendEvent(`r-${KEY}`, { id: 'e', timestamp: 1, type: 'x' as never, data: {} }));
    refused(() => store.saveSnapshot(`r-${KEY}`, { events: [] } as never));
    store.createSession({ id: 's1', cwd: '/c', engine: 'e' });
    refused(() => store.updateSession('s1', { engineSessionId: `es-${KEY}` }));

    // the two paths differ only in the key they hold: they must stay two different paths
    store.trust('/work/normal', '/work/normal/w', 'h');
    expect(store.isTrusted('/work/normal', '/work/normal/w', 'h')).toBe(true);
    expect(store.isTrusted(`/work/${KEY_B}`, `/work/${KEY_B}/w`, 'h')).toBe(false);
    expect(store.isTrusted(`/work/${KEY}`, `/work/${KEY}/w`, 'h')).toBe(false);
    expect(store.getSession('s1')).toMatchObject({ id: 's1', cwd: '/c', engine: 'e' });
    expect(store.getSession(`s-${KEY}`)).toBeUndefined();
    store.putSetting('plain', { v: 1 });
    expect(store.getSetting('plain')).toEqual({ v: 1 });
    expect(store.getSetting(`name-${KEY}`)).toBeUndefined();
  });

  it('a session written before the key was known is hidden, and /api/state does not fail', async () => {
    const dir = tmpDir();
    const inner = openStore(':memory:');
    inner.createSession({ id: `old-${KEY}`, cwd: tmpDir(), engine: 'claude-code' });
    inner.createSession({ id: 'fine', cwd: tmpDir(), engine: 'claude-code' });
    setKey(dir, 'a', KEY);
    const redactor = redactorFor(dir);
    const w = await boot([], { store: redactingStore(inner, redactor), dir, redactor });
    const state = await w.api('GET', '/api/state');
    expect(state.status).toBe(200);
    expect(state.text).not.toContain(KEY);
    expect((state.json.sessions as Array<{ id: string }>).map((s) => s.id)).toEqual(['fine']);
  });
});

describe('3. print --write', () => {
  const cli = async (argv: string[], env: NodeJS.ProcessEnv) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let err = '';
    stderr.on('data', (d) => (err += d));
    stdout.on('data', () => {});
    const code = await main(argv, { stdout, stderr, stdin: new PassThrough(), env: { ...process.env, ...env } });
    return { code, err };
  };

  it('refuses to rewrite a workflow that holds a key, writes nothing, and still rewrites a clean one', async () => {
    const t = tempHome();
    try {
      setKey(path.join(t.home, '.reins'), 'p', KEY);
      const cwd = tmpDir();
      const text = (s: string) => `---\nreins: 1\nname: w\ntask: t\nbudget: { turns: 5, minutes: 5 }\n---\n\n## phase one\n> ${s}\n`;
      const dirty = path.join(cwd, 'dirty.reins.md');
      fs.writeFileSync(dirty, text(`use ${KEY}`));
      const before = fs.readFileSync(dirty, 'utf8');
      const r = await cli(['print', dirty, '--write'], { REINS_HOME: t.home });
      expect(r.code).toBe(1);
      expect(r.err).toContain(KEY_IN_WORKFLOW);
      expect(fs.readFileSync(dirty, 'utf8')).toBe(before);

      const clean = path.join(cwd, 'clean.reins.md');
      fs.writeFileSync(clean, text('plain'));
      expect((await cli(['print', clean, '--write'], { REINS_HOME: t.home })).code).toBe(0);
    } finally {
      t.cleanup();
    }
  }, 60_000);
});

describe('8. the end of the terminal output', () => {
  usePack(); // M3: the terminal runs in this process, so the default pack is loaded for this block only
  it('the start of a key that never completes is hidden when the output ends (p29a A11: it used to be written), and a clean line before it is not lost', async () => {
    const t = tempHome();
    try {
      setKey(t.home, 'p', KEY);
      const cwd = tmpDir();
      fs.writeFileSync(path.join(cwd, 'print.mjs'), `process.stdout.write('line one\\ntail ' + ${JSON.stringify(KEY.slice(0, 10))});`);
      const file = path.join(cwd, 'w.reins.md');
      fs.writeFileSync(file, '---\nreins: 1\nname: tail\ntask: t\nbudget: { turns: 5, minutes: 5 }\n---\n\n## run `node print.mjs`\n');
      const output = new PassThrough();
      let text = '';
      output.setEncoding('utf8');
      output.on('data', (d: string) => (text += d));
      const redactor = redactorFor(t.home);
      const { startRunCli } = await import('../src/run-cli.js');
      const { FakeEngine } = await import('@reins/core');
      const r = await startRunCli({ file, cwd, input: new PassThrough(), output, store: redactingStore(openStore(':memory:'), redactor), redactor, makeEngine: () => new FakeEngine() }).done;
      expect(r.exitCode, text).toBe(0);
      expect(text).toContain('    line one\n');
      expect(text).toContain('    tail [hidden: text that looked like a key]'); // held back while it could still become the key, hidden at the end
      expect(text).not.toContain(KEY.slice(0, 10));
    } finally {
      t.cleanup();
    }
  }, 30_000);
});

describe('5. provider metadata', () => {
  it('a valid manifest whose label and model names hold a key shows no key in /api/state', async () => {
    const dir = tmpDir();
    setKey(dir, 'a', KEY);
    fs.mkdirSync(path.join(dir, 'mods', 'keyed'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mods', 'keyed', 'mod.json'), JSON.stringify({
      reins: 1, id: 'keyed', kind: 'provider', version: '1.0.0', label: `Keyed ${KEY}`, protocol: 'claude-code-cli', baseUrl: 'https://example.com',
      defaultModel: 'm', models: [{ id: 'm', label: `Model ${KEY}` }],
    }));
    const redactor = redactorFor(dir);
    const w = await boot([], { dir, redactor });
    const state = await w.api('GET', '/api/state');
    const keyed = (state.json.providers as Array<{ id: string; label: string; models: Array<{ label: string }> }>).find((p) => p.id === 'keyed');
    expect(keyed, state.text).toBeDefined();                     // the mod loaded: the test is about a real provider
    expect(keyed!.label).toBe('Keyed [key Reins]');
    expect(keyed!.models[0]!.label).toBe('Model [key Reins]');
    expect(state.text).not.toContain(KEY);
  });
});

describe('6. the change stamp of secrets.json', () => {
  it('a replacement of equal size and equal mtime is still seen', () => {
    const t = tempHome();
    try {
      const file = path.join(t.home, 'secrets.json');
      const T = 1_700_000_000.5;                                  // both files get the same modification time
      setKey(t.home, 'p', KEY);
      fs.utimesSync(file, T, T);
      const r = redactorFor(t.home);
      expect(r.redact(KEY)).toBe('[key Reins]');
      const st = fs.statSync(file);
      setKey(t.home, 'p', KEY_B);                                // a new file (rename) of the same size
      fs.utimesSync(file, T, T);
      const now = fs.statSync(file);
      expect(now.size).toBe(st.size);
      expect(now.mtimeMs).toBe(st.mtimeMs);                      // size and mtime alone cannot tell the two files apart
      expect(r.redact(KEY_B)).toBe('[key Reins]');               // no refresh() call
    } finally {
      t.cleanup();
    }
  });
});
