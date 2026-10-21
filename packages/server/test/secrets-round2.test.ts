// Task 7 fix round: streamed output, the store in and out, workflow writes, spawn environments, diagnostics, redactJson.
// Every key is an obvious fake; nothing touches the network.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { FakeEngine, type RunSnapshot } from '@reins/core';
import { main } from '../src/cli.js';
import { runCommand } from '../src/commands.js';
import { startRunCli } from '../src/run-cli.js';
import { childEnv, envGet, KEY_IN_WORKFLOW, keyFor, knownSecrets, Redactor, setKey, StreamRedactor } from '../src/secrets.js';
import { openStore, redactingStore } from '../src/store.js';
import { askedQuestion, boot, cleanup, openStream, tmpDir } from './http-helpers.js';
import { until } from './helpers.js';
import { tempHome } from './mods-harness.js';

const KEY = 'sk-test-0123456789abcdef';
const TURN = { fixture: 'claude-2.1.281-turns.jsonl', turn: 0 };
afterEach(cleanup);

const redactorFor = (home: string, env: NodeJS.ProcessEnv = {}, names: string[] = [], platform?: string) =>
  new Redactor({ home, env, keyEnvNames: () => names, ...(platform ? { platform } : {}) });
const withKey = (key = KEY) => {
  const t = tempHome();
  setKey(t.home, 'p', key);
  return { t, r: redactorFor(t.home) };
};
const chunksOf = (text: string, size: number) => text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? [];

function filesUnder(dir: string): Array<{ file: string; bytes: Buffer }> {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : [{ file: p, bytes: fs.readFileSync(p) }];
  });
}
const notIn = (dir: string, needle: string, skip = 'secrets.json') => {
  for (const f of filesUnder(dir)) if (path.basename(f.file) !== skip) expect(f.bytes.includes(Buffer.from(needle)), f.file).toBe(false);
};

describe('A. StreamRedactor', () => {
  it('finds a key split across 2, 5 and 1 character chunks, and never lets a fragment out', () => {
    const { t, r } = withKey();
    try {
      const text = `before ${KEY} after\nnext ${KEY}`;
      for (const size of [2, 5, 1, 7, 24]) {
        const s = new StreamRedactor(r);
        let out = '';
        for (const c of chunksOf(text, size)) {
          out += s.push(c);
          expect(out, `size ${size}`).not.toContain('sk-t');
        }
        out += s.end();
        expect(out, `size ${size}`).toBe('before [key Reins] after\nnext [key Reins]');
      }
    } finally {
      t.cleanup();
    }
  });

  it('holds back only a possible key start: ordinary output is not delayed, a half key is hidden at the end (p29a A11: it used to be written as it was)', () => {
    const { t, r } = withKey();
    try {
      const s = new StreamRedactor(r);
      expect(s.push('hello world, plain output\n')).toBe('hello world, plain output\n');
      expect(s.push('abc sk-te')).toBe('abc ');
      expect(s.end()).toBe('[hidden: text that looked like a key]');
      const s2 = new StreamRedactor(r);
      expect(s2.push('sk-test-0123456789abcde')).toBe('');          // one character short
      expect(s2.push('f!')).toBe('[key Reins]!');
    } finally {
      t.cleanup();
    }
  });

  it('a whole key that reaches into the end that is held back is not cut in two', () => {
    const t = tempHome();
    try {
      setKey(t.home, 'a', 'abcdefgh1');
      const r = redactorFor(t.home, { X_API_KEY: 'fgh1-other-long' }, ['X_API_KEY']);
      const s = new StreamRedactor(r);
      expect(s.push('xxabcdefgh1')).toBe('xx');                   // "fgh1" starts the second key, but "abcdefgh1" is whole and ends there
      expect(s.push('!')).toBe('[key Reins]!');
    } finally {
      t.cleanup();
    }
  });

  it('a key in its JSON-escaped form is found across chunks too, and a key that holds a newline', () => {
    const tricky = 'sk-"q"-back\\slash-é-line\nbreak-0123';
    const { t, r } = withKey(tricky);
    try {
      for (const [text, want] of [[JSON.stringify({ a: tricky }), '{"a":"[key Reins]"}'], [`x ${tricky} y`, 'x [key Reins] y']] as const) {
        for (const size of [1, 3]) {
          const s = new StreamRedactor(r);
          const out = chunksOf(text, size).map((c) => s.push(c)).join('') + s.end();
          expect(out).toBe(want);
        }
      }
    } finally {
      t.cleanup();
    }
  });

  it('a character cut between two chunks is decoded whole by runCommand, so the key behind it is still found', async () => {
    const key = 'sk-é-test-0123456789';
    const { t, r } = withKey(key);
    try {
      const cwd = tmpDir();
      fs.writeFileSync(path.join(cwd, 'cut.mjs'),
        `const b = Buffer.from(${JSON.stringify(key)}); const cut = b.indexOf(0xc3) + 1;\n`
        + 'process.stdout.write(b.subarray(0, cut)); setTimeout(() => { process.stdout.write(b.subarray(cut)); process.stdout.write("\\n"); }, 250);\n');
      const chunks: string[] = [];
      await runCommand('node cut.mjs', { cwd, onOutput: (s) => chunks.push(s) });
      expect(chunks.join('')).toBe(`${key}\n`);
      expect(chunks.join('')).not.toContain('�');
      const s = new StreamRedactor(r);
      expect(chunks.map((c) => s.push(c)).join('') + s.end()).toBe('[key Reins]\n');
    } finally {
      t.cleanup();
    }
  });
});

/** `reins run` over a workflow with one command, which is the script `body`. Returns the terminal text. */
function cliRun(body: string, key = KEY) {
  const { t, r } = withKey(key);
  const cwd = tmpDir();
  fs.writeFileSync(path.join(cwd, 'print.mjs'), body);
  const file = path.join(cwd, 'w.reins.md');
  fs.writeFileSync(file, '---\nreins: 1\nname: leak-check\ntask: print\nbudget: { turns: 5, minutes: 5 }\n---\n\n## run `node print.mjs`\n');
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8');
  output.on('data', (d: string) => (text += d));
  const h = startRunCli({ file, cwd, input, output, store: redactingStore(openStore(':memory:'), r), redactor: r, makeEngine: () => new FakeEngine() });
  return { h, input, text: () => text, done: async () => { try { return await h.done; } finally { t.cleanup(); } } };
}

describe('A. the terminal (reins run)', () => {
  it('a key that straddles the old 64 KB cut is not cut', async () => {
    // the old code wrote everything but the last 4096 characters once 64 KB was held: here that point falls inside the key
    const c = cliRun(`const k = ${JSON.stringify(KEY)};
process.stdout.write('x'.repeat(61440) + k);
setTimeout(() => process.stdout.write('y'.repeat(4082)), 200);
setTimeout(() => process.stdout.write('\\n'), 400);
setTimeout(() => process.stdout.write(k + '\\n'), 600);`);
    const r = await c.done();
    expect(r.exitCode, c.text()).toBe(0);
    expect(c.text()).not.toContain('sk-test-01');
    expect(c.text()).not.toContain('23456789abcdef');
    expect(c.text()).toContain('[key Reins]');
    expect(c.text().match(/\[key Reins\]/g)).toHaveLength(2);
  }, 30_000);

  it('a key split across a say() (Ctrl-C) is not written in two pieces', async () => {
    const c = cliRun(`const k = ${JSON.stringify(KEY)};
process.stdout.write(k.slice(0, 10));
setTimeout(() => process.stdout.write(k.slice(10) + '\\n'), 1200);`);
    await until(() => c.text().includes('$ node print.mjs'), 20_000);
    await new Promise((r) => setTimeout(r, 400));
    c.h.sigint();                                              // says "^C  stop card sent"
    await until(() => c.text().includes('^C'), 5000);
    expect(c.text()).not.toContain('sk-test-01');
    await until(() => c.text().includes('resume [note] / stop'), 20_000);
    c.input.write('stop\n');
    await c.done();
    expect(c.text()).not.toContain('sk-test-01');
    expect(c.text()).not.toContain('23456789abcdef');
    expect(c.text()).toContain('[key Reins]');
  }, 60_000);

  it('a key with a newline in it is redacted before the output is indented', async () => {
    const key = 'multi-line-secret-one\nmulti-line-secret-two';
    const c = cliRun(`process.stdout.write('before ' + ${JSON.stringify(key)} + ' after\\n');`, key);
    await c.done();
    expect(c.text()).toContain('before [key Reins] after');
    expect(c.text()).not.toContain('secret-one');
    expect(c.text()).not.toContain('secret-two');
  }, 30_000);
});

describe('A. a session logs a command in rows that are clean one by one', () => {
  it('two consecutive command_output rows never add up to the key, and neither holds a piece of it', async () => {
    const dir = tmpDir();
    setKey(dir, 'p', KEY);
    const redactor = redactorFor(dir);
    const w = await boot([TURN], { store: redactingStore(openStore(':memory:'), redactor), dir, redactor });
    const id = await w.session();
    fs.writeFileSync(path.join(w.cwd, 'print.mjs'), `const k = ${JSON.stringify(KEY)};
process.stdout.write('go ' + k.slice(0, 9));
setTimeout(() => process.stdout.write(k.slice(9, 15)), 300);
setTimeout(() => process.stdout.write(k.slice(15) + ' end\\n'), 600);`);
    const file = path.join(w.cwd, 'a.reins.md');
    fs.writeFileSync(file, '---\nreins: 1\nname: leak-check\ntask: print\nbudget: { turns: 5, minutes: 5 }\n---\n\n## run `node print.mjs`\n');
    expect((await w.post(id, 'run', { path: file })).status).toBe(200);
    await w.answer(id, (await askedQuestion(w.store, id, 'trust')).id, 'y');
    await until(() => w.rows(id, 'run_finished').length === 1, 30_000);
    const rows = w.rows(id, 'command_output').map((r) => (r.data as { chunk: string }).chunk);
    expect(rows.join('')).toContain('go [key Reins] end');
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i]).not.toContain('sk-test-01');
      expect(rows[i]).not.toContain('23456789abcdef');
      if (i > 0) expect(rows[i - 1]! + rows[i]!).not.toContain(KEY);
    }
  }, 60_000);
});

describe('B. the store: every string in, and every read', () => {
  it('content fields are redacted on the way in (title, model, effort, log and event types and data, snapshot, editor text, setting value)', () => {
    // identity fields (ids, paths, hashes, names) are refused instead: secrets-round3.test.ts
    const dir = tmpDir();
    setKey(dir, 'p', KEY);
    const store = redactingStore(openStore(path.join(dir, 'reins.db')), redactorFor(dir));
    const k = (s: string) => `${s}-${KEY}`;
    store.createRun({ id: 'r1', workflowPath: '/w', cwd: '/c' });
    store.createSession({ id: 's1', cwd: '/c', engine: 'e', model: k('m'), effort: k('f'), title: k('t') });
    store.updateSession('s1', { model: k('m2'), effort: k('f2'), title: k('t2') });
    store.putEditorState('/c', JSON.stringify({ text: k('draft') }));
    store.putSetting('name', { v: k('value') });
    store.appendLog('s1', { type: k('ty'), data: { a: KEY } });
    store.appendEvent('r1', { id: 'ev', timestamp: 1, type: k('ty') as never, data: { a: KEY } });
    store.saveSnapshot('r1', { note: KEY, events: [] } as never);
    notIn(dir, KEY);
    expect(JSON.stringify(store.getSession('s1'))).not.toContain(KEY);
    expect(store.getSetting('name')).toEqual({ v: 'value-[key Reins]' });
    store.close();
  });

  it('session model and effort are redacted in the stored row', () => {
    const inner = openStore(':memory:');
    const { t, r } = withKey();
    try {
      const store = redactingStore(inner, r);
      store.createSession({ id: 's1', cwd: '/c', engine: 'e', model: `m-${KEY}`, effort: `f-${KEY}` });
      store.updateSession('s1', { model: `m2-${KEY}`, effort: `f2-${KEY}` });
      expect(inner.getSession('s1')).toMatchObject({ model: 'm2-[key Reins]', effort: 'f2-[key Reins]' });
      store.createSession({ id: 's2', cwd: '/c', engine: 'e', model: `m-${KEY}`, effort: `f-${KEY}` });
      expect(inner.getSession('s2')).toMatchObject({ model: 'm-[key Reins]', effort: 'f-[key Reins]' });
    } finally {
      t.cleanup();
    }
  });

  it('a key registered AFTER rows were written does not leave through any read', () => {
    const inner = openStore(':memory:');
    const t = tempHome();
    try {
      const before = redactingStore(inner, redactorFor(t.home));      // no key known yet
      before.createRun({ id: 'r1', workflowPath: '/w', cwd: '/c' });
      before.createSession({ id: 's1', cwd: '/c', engine: 'e', title: `t ${KEY}` });
      before.appendLog('s1', { type: 'note', data: { text: KEY } });
      before.appendEvent('r1', { id: 'e1', timestamp: 1, type: 'x' as never, data: { text: KEY } });
      before.saveSnapshot('r1', { note: KEY, events: [] } as unknown as RunSnapshot);
      before.putEditorState('/c', JSON.stringify({ draft: KEY }));
      before.putSetting('s', { v: KEY });
      before.putEngineTotal('es', 1, { [`m-${KEY}`]: 1 });
      expect(JSON.stringify(inner.readLog('s1'))).toContain(KEY);     // it is in the database, as the known limit says

      setKey(t.home, 'p', KEY);
      const after = redactingStore(inner, redactorFor(t.home));
      for (const v of [after.readLog('s1'), after.getSession('s1'), after.listSessions(), after.loadRun('r1'), after.getEditorState('/c'), after.getSetting('s'), after.getEngineModels('es')]) {
        expect(JSON.stringify(v)).not.toContain(KEY);
      }
      expect(after.readLog('s1').at(-1)!.data).toEqual({ text: '[key Reins]' });
    } finally {
      t.cleanup();
    }
  });

  it('a key registered after rows were written does not leave through the REST log or the SSE replay', async () => {
    const dir = tmpDir();
    const redactor = redactorFor(dir);
    const w = await boot([], { store: redactingStore(openStore(':memory:'), redactor), dir, redactor });
    const id = await w.session();
    w.store.appendLog(id, { type: 'note', data: { text: KEY } });
    setKey(dir, 'p', KEY);                                            // no refresh(): the change on disk is seen
    const rest = await w.api('GET', `/api/sessions/${id}/log?after=0`);
    expect(rest.text).not.toContain(KEY);
    expect(rest.text).toContain('[key Reins]');
    const s = openStream(w.srv);
    await s.ready;
    await until(() => s.rows.some((r) => r.type === 'note'));
    expect(JSON.stringify(s.rows)).not.toContain(KEY);
  });
});

describe('C. workflow writes refuse a known key', () => {
  it('the tagged prompt and the editor save are refused; a normal save still works', async () => {
    const dir = tmpDir();
    setKey(dir, 'p', KEY);
    const redactor = redactorFor(dir);
    const w = await boot([TURN], { store: redactingStore(openStore(':memory:'), redactor), dir, redactor });
    const id = await w.session();

    const refused = await w.api('POST', `/api/sessions/${id}/message`, { body: { text: `use ${KEY} here`, tags: [{ tag: 'read-only' }] } });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toBe(KEY_IN_WORKFLOW);
    expect(fs.existsSync(path.join(dir, 'runs'))).toBe(false);

    const rel = '.reins/workflows/a.reins.md';
    const text = (s: string) => `---\nreins: 1\nname: a\nbudget: { turns: 5, minutes: 5 }\n---\n\n## phase one\n> ${s}\n`;
    const bad = await w.api('PUT', `/api/sessions/${id}/workflow`, { body: { path: rel, text: text(KEY), create: true } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe(KEY_IN_WORKFLOW);
    expect(fs.existsSync(path.join(w.cwd, rel))).toBe(false);

    const good = await w.api('PUT', `/api/sessions/${id}/workflow`, { body: { path: rel, text: text('do the thing'), create: true } });
    expect(good.status).toBe(200);
    expect(fs.readFileSync(path.join(w.cwd, rel), 'utf8')).toContain('do the thing');

    const fine = await w.api('POST', `/api/sessions/${id}/message`, { body: { text: 'plain request', tags: [{ tag: 'read-only' }] } });
    expect(fine.status).toBe(200);
    await until(() => fs.existsSync(path.join(dir, 'runs')));
  }, 30_000);
});

describe('D. the server cleans an env it is given', () => {
  it('a workflow command does not see an installed keyEnv var even when the server was handed the full env', async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'mods', 'keyed'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mods', 'keyed', 'mod.json'), JSON.stringify({
      reins: 1, id: 'keyed', kind: 'provider', version: '1.0.0', label: 'Keyed', protocol: 'claude-code-cli', baseUrl: 'https://example.com',
      auth: { style: 'bearer', keyEnv: ['X_API_KEY'] }, defaultModel: 'm', models: [{ id: 'm' }],
    }));
    const w = await boot([TURN], { dir, env: { ...process.env, X_API_KEY: KEY, REINS_HOME: '/somewhere', KEEP_ME: 'kept' } });
    const id = await w.session();
    fs.writeFileSync(path.join(w.cwd, 'env.mjs'), 'console.log(`${process.env.X_API_KEY ?? "none"}|${process.env.REINS_HOME ?? "none"}|${process.env.KEEP_ME ?? "none"}`);');
    const file = path.join(w.cwd, 'a.reins.md');
    fs.writeFileSync(file, '---\nreins: 1\nname: env\ntask: print\nbudget: { turns: 5, minutes: 5 }\n---\n\n## run `node env.mjs`\n');
    expect((await w.post(id, 'run', { path: file })).status).toBe(200);
    await w.answer(id, (await askedQuestion(w.store, id, 'trust')).id, 'y');
    await until(() => w.rows(id, 'run_finished').length === 1, 30_000);
    expect(w.rows(id, 'command_output').map((r) => (r.data as { chunk: string }).chunk).join('')).toContain('none|none|kept');
  }, 60_000);
});

describe('D. env names compare the way the OS does', () => {
  const env = { x_api_key: KEY, Path: '/bin', reins_home: '/h', KEEP: 'y' };

  it('on win32 a lowercase name is found, dropped and redacted; elsewhere names are exact', () => {
    const p = { id: 'p', auth: { style: 'bearer', keyEnv: ['X_API_KEY'] } };
    expect(envGet(env, 'X_API_KEY', 'win32')).toBe(KEY);
    expect(envGet(env, 'X_API_KEY', 'linux')).toBeUndefined();
    expect(keyFor(p, new Map(), env, 'win32')).toEqual({ kind: 'key', key: KEY, source: 'X_API_KEY' });
    expect(keyFor(p, new Map(), env, 'linux')).toEqual({ kind: 'missing' });
    expect(knownSecrets(new Map(), env, ['X_API_KEY'], 'win32')).toEqual([{ value: KEY, name: 'X_API_KEY' }]);
    expect(knownSecrets(new Map(), env, ['X_API_KEY'], 'linux')).toEqual([]);
    expect(childEnv(env, ['X_API_KEY'], 'win32')).toEqual({ Path: '/bin', KEEP: 'y' });
    expect(childEnv(env, ['X_API_KEY'], 'linux')).toEqual({ x_api_key: KEY, Path: '/bin', reins_home: '/h', KEEP: 'y' });
    const t = tempHome();
    try {
      expect(redactorFor(t.home, env, ['X_API_KEY'], 'win32').redact(`k ${KEY}`)).toBe('k [key X_API_KEY]');
    } finally {
      t.cleanup();
    }
  });
});

describe('E. diagnostics', () => {
  const cli = async (argv: string[], env: NodeJS.ProcessEnv, extra: { open?: (url: string) => void; stop?: Promise<void> } = {}) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = '';
    let err = '';
    stdout.on('data', (d) => (out += d));
    stderr.on('data', (d) => (err += d));
    const code = await main(argv, { stdout, stderr, stdin: new PassThrough(), env: { ...process.env, ...env }, ...extra });
    return { code, out, err };
  };

  it('doctor hides the env value of a REJECTED mod, even when its key name fails the key-name pattern', async () => {
    const t = tempHome();
    try {
      const reins = path.join(t.home, '.reins');
      const mod = (id: string, value: string, name: string) => {
        fs.mkdirSync(path.join(reins, 'mods', id), { recursive: true });
        fs.writeFileSync(path.join(reins, 'mods', id, 'mod.json'), JSON.stringify({
          reins: 1, id, kind: 'provider', version: '1.0.0', label: id, protocol: 'claude-code-cli', baseUrl: value, auth: { style: 'bearer', keyEnv: [name] },
          defaultModel: 'm', models: [{ id: 'm' }],
        }));
      };
      mod('bad-one', 'sk-env-value-0001', 'BAD_API_KEY');
      mod('bad-two', 'sk-env-value-0002', 'SECRET_API_KEY');         // refused by the key-name pattern
      const env = { REINS_HOME: t.home, BAD_API_KEY: 'sk-env-value-0001', SECRET_API_KEY: 'sk-env-value-0002' };
      const r = await cli(['doctor', '--no-probe'], env);
      expect(r.out).toMatch(/mod\s+bad-one/);
      expect(r.out).not.toContain('sk-env-value-0001');
      expect(r.out).not.toContain('sk-env-value-0002');
      expect(r.out).toContain('[key BAD_API_KEY]');
      expect(r.out).toContain('[key SECRET_API_KEY]');
    } finally {
      t.cleanup();
    }
  }, 60_000);

  it('the CLI prints nothing with a key in it: check, print, a usage error, a thrown error', async () => {
    const t = tempHome();
    try {
      const reins = path.join(t.home, '.reins');
      setKey(reins, 'p', KEY);
      const env = { REINS_HOME: t.home };
      const cwd = tmpDir();
      const missing = await cli(['check', path.join(cwd, `${KEY}.reins.md`)], env);
      expect(missing.out + missing.err).not.toContain(KEY);
      expect(missing.out).toContain('[key Reins]');

      const file = path.join(cwd, 'w.reins.md');
      fs.writeFileSync(file, `---\nreins: 1\nname: w\ntask: t\nbudget: { turns: 5, minutes: 5 }\n---\n\n## phase one\n> use ${KEY}\n`);
      const printed = await cli(['print', file], env);
      expect(printed.code).toBe(0);
      expect(printed.out).toContain('[key Reins]');
      expect(printed.out).not.toContain(KEY);

      const named = await cli(['run', file, '--provider', KEY], env);
      expect(named.code).toBe(1);
      expect(named.err).not.toContain(KEY);
      expect(named.err).toContain('[key Reins]');

      const err = await cli([], env, { open: () => { throw new Error(`cannot open ${KEY}`); }, stop: Promise.resolve() }).then(() => undefined, (e: Error) => e);
      expect(err?.message).toContain('[key Reins]');
      expect(err?.message).not.toContain(KEY);
    } finally {
      t.cleanup();
    }
  }, 60_000);
});

describe('G. lines the first round left unproven', () => {
  it('a write that fails (the target is a folder) removes its temp file and throws', () => {
    const t = tempHome();
    try {
      fs.mkdirSync(path.join(t.home, 'secrets.json'));
      expect(() => setKey(t.home, 'p', KEY)).toThrow();
      expect(fs.readdirSync(t.home).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('a provider with no auth block needs no key', () => {
    expect(keyFor({ id: 'local' }, new Map([['local', 'stored-key-001']]), { X_API_KEY: KEY })).toEqual({ kind: 'none' });
  });
});

describe('F. redactJson walks the structure', () => {
  it('a numeric secret stays a number, and an object stays an object', () => {
    const { t, r } = withKey('12345678');
    try {
      const out = r.redactJson({ n: 12345678, s: 'x 12345678 y', list: [12345678, '12345678'] });
      expect(out).toEqual({ n: 12345678, s: 'x [key Reins] y', list: [12345678, '[key Reins]'] });
      expect(typeof out).toBe('object');
    } finally {
      t.cleanup();
    }
  });

  it('a snapshot-shaped object keeps its shape: strings and keys redacted, arrays, numbers, booleans, null and undefined kept', () => {
    const { t, r } = withKey();
    try {
      const snap = { status: 'running', events: [], step: 3, paused: false, note: null, gone: undefined, tags: [`a ${KEY}`, 2], deep: { [`k-${KEY}`]: { inner: `${KEY}${KEY}` } } };
      const out = r.redactJson(snap);
      expect(out).toEqual({ status: 'running', events: [], step: 3, paused: false, note: null, gone: undefined, tags: ['a [key Reins]', 2], deep: { 'k-[key Reins]': { inner: '[key Reins][key Reins]' } } });
      expect(Array.isArray(out.tags)).toBe(true);
      expect(snap.tags[0]).toContain(KEY);                           // the input is not changed
    } finally {
      t.cleanup();
    }
  });

  it('a JSON text inside a string value is redacted through the escaped form', () => {
    const tricky = 'sk-"q"-back\\slash-0123';
    const { t, r } = withKey(tricky);
    try {
      const out = r.redactJson({ body: JSON.stringify({ auth: tricky }) });
      expect(out.body).toBe('{"auth":"[key Reins]"}');
    } finally {
      t.cleanup();
    }
  });
});
