// Keys (spec 8.1 to 8.4): the secrets file, redaction at every write and at the terminal, the env children get.
// Every key here is an obvious fake; nothing touches the network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { FakeEngine, type RunSnapshot } from '@reins/core';
import { main } from '../src/cli.js';
import { runCommand } from '../src/commands.js';
import { startRunCli } from '../src/run-cli.js';
import { childEnv, clearKey, keyFor, keyStatus, knownSecrets, readSecrets, Redactor, redactCut, setKey, StreamRedactor } from '../src/secrets.js';
import { startServer } from '../src/server.js';
import { openStore, redactingStore } from '../src/store.js';
import { boot, cleanup, openStream, request, tmpDir } from './http-helpers.js';
import { until } from './helpers.js';
import { tempHome } from './mods-harness.js';

const KEY = 'sk-test-0123456789abcdef';
afterEach(cleanup);

const noEnv = (home: string, env: NodeJS.ProcessEnv = {}, names: string[] = []) => new Redactor({ home, env, keyEnvNames: () => names });

/** Every file under `dir`, as bytes, with its path. */
function filesUnder(dir: string): Array<{ file: string; bytes: Buffer }> {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : [{ file: p, bytes: fs.readFileSync(p) }];
  });
}

describe('1. the secrets file', () => {
  it('setKey writes a temp file in the same folder, then renames it over secrets.json', () => {
    const t = tempHome();
    try {
      const real = fs.renameSync;
      const seen: Array<{ from: string; to: string; fromText: string; toBefore: string | undefined }> = [];
      const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        seen.push({
          from: String(from), to: String(to), fromText: fs.readFileSync(from, 'utf8'),
          toBefore: fs.existsSync(to) ? fs.readFileSync(to, 'utf8') : undefined,
        });
        real(from, to);
      });
      try {
        setKey(t.home, 'p', KEY);
        setKey(t.home, 'p', KEY + '2');
      } finally {
        spy.mockRestore();
      }
      const target = path.join(t.home, 'secrets.json');
      expect(seen).toHaveLength(2);
      for (const s of seen) {
        expect(s.to).toBe(target);
        expect(s.from).not.toBe(target);
        expect(path.dirname(s.from)).toBe(t.home);
        expect(s.fromText).toContain('"providers"');
      }
      expect(seen[0]!.toBefore).toBeUndefined();
      expect(seen[1]!.toBefore).toContain(KEY);          // the old file stayed whole until the rename
      expect(seen[1]!.toBefore).not.toContain(KEY + '2');
      expect(fs.readdirSync(t.home).filter((n) => n.endsWith('.tmp'))).toEqual([]);
      expect(readSecrets(t.home).get('p')).toBe(KEY + '2');
    } finally {
      t.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('the file has mode 0o600 (POSIX only: skipped on Windows, which ignores the mode; this machine cannot run it)', () => {
    const t = tempHome();
    try {
      setKey(t.home, 'p', KEY);
      expect(fs.statSync(path.join(t.home, 'secrets.json')).mode & 0o777).toBe(0o600);
    } finally {
      t.cleanup();
    }
  });

  it('a corrupt, missing or oddly shaped file reads as empty and never throws; setKey then repairs it', () => {
    const t = tempHome();
    try {
      const file = path.join(t.home, 'secrets.json');
      expect(readSecrets(t.home).size).toBe(0);
      for (const text of ['not json {', '', 'null', '[]', '{"providers":[1]}', '{"providers":{"a":{"key":5}}}', '{"providers":{"a":null,"b":{"key":""}}}']) {
        fs.writeFileSync(file, text);
        expect(readSecrets(t.home).size, text).toBe(0);
      }
      fs.writeFileSync(file, 'not json {');
      setKey(t.home, 'p', KEY);
      expect([...readSecrets(t.home)]).toEqual([['p', KEY]]);
    } finally {
      t.cleanup();
    }
  });

  it('ids like __proto__, constructor and toString are plain ids: no pollution, no collision', () => {
    const t = tempHome();
    try {
      setKey(t.home, '__proto__', 'proto-key-0001');
      setKey(t.home, 'constructor', 'ctor-key-00002');
      setKey(t.home, 'toString', 'tostr-key-00003');
      const text = fs.readFileSync(path.join(t.home, 'secrets.json'), 'utf8');
      expect(text).toContain('"__proto__"');
      const back = readSecrets(t.home);
      expect(Object.fromEntries(back)).toEqual({ constructor: 'ctor-key-00002', toString: 'tostr-key-00003', ['__proto__' as string]: 'proto-key-0001' });
      expect(back.get('__proto__')).toBe('proto-key-0001');
      expect(back.get('constructor')).toBe('ctor-key-00002');
      expect(back.get('toString')).toBe('tostr-key-00003');
      expect(back.get('hasOwnProperty')).toBeUndefined();
      expect(({} as Record<string, unknown>).key).toBeUndefined();
      expect(Object.getPrototypeOf(JSON.parse(text).providers)).toBe(Object.prototype);
      clearKey(t.home, '__proto__');
      expect([...readSecrets(t.home).keys()].sort()).toEqual(['constructor', 'toString']);
      setKey(t.home, 'constructor', '   ');                  // an empty value clears
      expect([...readSecrets(t.home).keys()]).toEqual(['toString']);
    } finally {
      t.cleanup();
    }
  });
});

describe('2. keyFor and keyStatus', () => {
  const p = { id: 'deep', auth: { style: 'bearer', keyEnv: ['A_API_KEY', 'B_API_KEY'] } };

  it('the secrets entry first, else the first set env var; an empty one is not set', () => {
    const secrets = new Map([['deep', 'from-file-key-1']]);
    expect(keyFor(p, secrets, { A_API_KEY: 'from-env-a-key', B_API_KEY: 'from-env-b-key' })).toEqual({ kind: 'key', key: 'from-file-key-1', source: 'Reins' });
    expect(keyFor(p, new Map(), { A_API_KEY: 'from-env-a-key', B_API_KEY: 'from-env-b-key' })).toEqual({ kind: 'key', key: 'from-env-a-key', source: 'A_API_KEY' });
    expect(keyFor(p, new Map(), { A_API_KEY: '', B_API_KEY: 'from-env-b-key' })).toEqual({ kind: 'key', key: 'from-env-b-key', source: 'B_API_KEY' });
    expect(keyFor(p, new Map(), { A_API_KEY: '' })).toEqual({ kind: 'missing' });
    expect(keyFor(p, new Map([['other', 'x-other-key-1']]), {})).toEqual({ kind: 'missing' });
  });

  it('reads the injected env, never process.env', () => {
    process.env.A_API_KEY = 'process-env-key-1';
    try {
      expect(keyFor(p, new Map(), {})).toEqual({ kind: 'missing' });
    } finally {
      delete process.env.A_API_KEY;
    }
  });

  it('auth.style none means no key is needed, whatever is stored or set', () => {
    const local = { id: 'local', auth: { style: 'none', keyEnv: ['A_API_KEY'] } };
    expect(keyFor(local, new Map(), {})).toEqual({ kind: 'none' });
    expect(keyFor(local, new Map([['local', 'stored-key-001']]), { A_API_KEY: 'from-env-a-key' })).toEqual({ kind: 'none' });
    expect(keyStatus(local, new Map(), {})).toEqual({ state: 'none' });
  });

  it('keyStatus says set (and from where), missing or none, and never carries the value', () => {
    const secrets = new Map([['deep', KEY]]);
    expect(keyStatus(p, secrets, {})).toEqual({ state: 'set', source: 'Reins' });
    expect(keyStatus(p, new Map(), { B_API_KEY: KEY })).toEqual({ state: 'set', source: 'B_API_KEY' });
    expect(keyStatus(p, new Map(), {})).toEqual({ state: 'missing' });
    for (const s of [keyStatus(p, secrets, { A_API_KEY: KEY }), keyStatus(p, new Map(), { B_API_KEY: KEY })]) expect(JSON.stringify(s)).not.toContain(KEY);
  });

  it('a key is trimmed once, from either source, so what is sent is what knownSecrets hides', () => {
    const raw = 'sk-trim-0123456789abcdef';
    expect(keyFor(p, new Map(), { A_API_KEY: `${raw}\n` })).toEqual({ kind: 'key', key: raw, source: 'A_API_KEY' });
    expect(keyFor(p, new Map(), { A_API_KEY: `  ${raw} \r\n\t` })).toEqual({ kind: 'key', key: raw, source: 'A_API_KEY' });
    expect(keyFor(p, new Map([['deep', ` ${raw}\n`]]), {})).toEqual({ kind: 'key', key: raw, source: 'Reins' });
    // the value as stored and its trimmed form are both known
    expect(knownSecrets(new Map([['deep', ` ${raw}\n`]]), { A_API_KEY: `${raw}2 \n` }, ['A_API_KEY']).map((s) => s.value)).toEqual([` ${raw}\n`, raw, `${raw}2 \n`, `${raw}2`]);
  });

  it('the raw and the trimmed form each need 8 characters on their own: " abcdefg " is hidden whole, and keyFor still sends it trimmed', () => {
    expect(knownSecrets(new Map(), { A_API_KEY: ' abcdefg ' }, ['A_API_KEY'])).toEqual([{ value: ' abcdefg ', name: 'A_API_KEY' }]);
    expect(knownSecrets(new Map([['deep', '  abcdefg  ']]), {}, [])).toEqual([{ value: '  abcdefg  ', name: 'Reins' }]);
    expect(knownSecrets(new Map([['deep', ' abcdefg']]), {}, [])).toEqual([{ value: ' abcdefg', name: 'Reins' }]); // 8 raw characters with the space: known; 7 trimmed: not
    expect(keyFor(p, new Map(), { A_API_KEY: ' abcdefg ' })).toEqual({ kind: 'key', key: 'abcdefg', source: 'A_API_KEY' });
    expect(knownSecrets(new Map(), { A_API_KEY: 'abcdefg' }, ['A_API_KEY'])).toEqual([]);
  });

  it('a Redactor hides the padded raw form of a short key whole', () => {
    const r = new Redactor({ home: tmpDir(), env: { A_API_KEY: ' abcdefg ' }, keyEnvNames: () => ['A_API_KEY'] });
    expect(r.redact('the key is " abcdefg " here')).toBe('the key is "[key A_API_KEY]" here');
  });

  it('a key that is only whitespace is missing, from either source', () => {
    expect(keyFor(p, new Map([['deep', ' \n ']]), { A_API_KEY: '  \t' })).toEqual({ kind: 'missing' });
    expect(keyStatus(p, new Map(), { A_API_KEY: '\n' })).toEqual({ state: 'missing' });
  });
});

describe('3. redact and redactJson', () => {
  it('hides secrets-file values and the values of installed keyEnv names, each named; an env var no provider names is left', () => {
    const t = tempHome();
    try {
      setKey(t.home, 'p', KEY);
      const env = { X_API_KEY: 'sk-test-envvalue-0002', OTHER_API_KEY: 'sk-test-notinstalled-3' };
      const r = noEnv(t.home, env, ['X_API_KEY']);
      expect(r.redact(`a ${KEY} b ${env.X_API_KEY} c ${env.OTHER_API_KEY}`)).toBe(`a [key Reins] b [key X_API_KEY] c ${env.OTHER_API_KEY}`);
      expect(r.redact(`${KEY}${KEY}`)).toBe('[key Reins][key Reins]');
    } finally {
      t.cleanup();
    }
  });

  it('a value of 7 characters is left alone, one of 8 is hidden', () => {
    const t = tempHome();
    try {
      const r = noEnv(t.home, { X_API_KEY: 'abcdefg', Y_API_KEY: 'abcdefgh' }, ['X_API_KEY', 'Y_API_KEY']);
      expect(r.redact('see abcdefg here')).toBe('see abcdefg here');
      expect(r.redact('see abcdefgh here')).toBe('see [key Y_API_KEY] here');
      setKey(t.home, 'p', '1234567');
      r.refresh();
      expect(r.redact('1234567')).toBe('1234567');
    } finally {
      t.cleanup();
    }
  });

  it('replaces longest first: a secret that contains another is removed whole', () => {
    const t = tempHome();
    try {
      setKey(t.home, 'short', 'sk-test-0123456789');
      const long = 'sk-test-0123456789abcdef-LONGTAIL';
      const r = noEnv(t.home, { X_API_KEY: long }, ['X_API_KEY']);
      expect(r.redact(`k=${long}!`)).toBe('k=[key X_API_KEY]!');
      expect(r.redact('k=sk-test-0123456789!')).toBe('k=[key Reins]!');
    } finally {
      t.cleanup();
    }
  });

  it('redactJson keeps valid JSON when the secret sits inside a JSON string (quote, backslash, unicode)', () => {
    const t = tempHome();
    try {
      const tricky = 'sk-"q"-back\\slash-é-☃-😀-line\nbreak';
      setKey(t.home, 'p', tricky);
      const r = noEnv(t.home);
      const v = { a: `x ${tricky} y`, [tricky]: 1, list: [tricky, 2, { deep: `${tricky}${tricky}` }], keep: 'plain', n: null };
      const text = JSON.stringify(v);
      expect(text).not.toContain(tricky);                              // the JSON text holds the escaped form
      const out = r.redactJson(v);
      expect(out).toEqual({ a: 'x [key Reins] y', '[key Reins]': 1, list: ['[key Reins]', 2, { deep: '[key Reins][key Reins]' }], keep: 'plain', n: null });
      const raw = r.redact(text);
      expect(() => JSON.parse(raw)).not.toThrow();
      const escaped = JSON.stringify(tricky).slice(1, -1);
      expect(raw).not.toContain(escaped);
      expect(raw).not.toContain('break');
      expect(r.redact(JSON.stringify({ title: tricky }))).toBe('{"title":"[key Reins]"}');
      expect(r.redactJson(undefined)).toBeUndefined();
      expect(r.redactJson('plain')).toBe('plain');
    } finally {
      t.cleanup();
    }
  });

  it('a key set or cleared later is picked up: by refresh(), and by the file changing on disk', () => {
    const t = tempHome();
    try {
      const r = noEnv(t.home);
      expect(r.redact(KEY)).toBe(KEY);
      setKey(t.home, 'p', KEY);
      expect(r.redact(KEY)).toBe('[key Reins]');                    // seen through the file's stat
      clearKey(t.home, 'p');
      r.refresh();
      expect(r.redact(KEY)).toBe('[key Reins]');                    // a retired key stays masked for the life of the process (Task 21 fix round)
    } finally {
      t.cleanup();
    }
  });
});

describe('4. the sweep: no key bytes in any file, in the SSE body, or in what appendLog returns', () => {
  it('a key in a title, a log row, a run event, a snapshot, an editor state and a setting reaches no file and no stream', async () => {
    const dir = tmpDir();
    setKey(dir, 'p', KEY);
    const redactor = noEnv(dir);
    const store = redactingStore(openStore(path.join(dir, 'reins.db')), redactor);
    const w = await boot([{ fixture: 'claude-2.1.281-turns.jsonl', turn: 0 }], { store, dir });

    // the raw SSE body, from the start
    let sse = '';
    const req = http.request({ host: '127.0.0.1', port: w.srv.port, path: `/api/stream?token=${w.srv.token}`, agent: false }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d: string) => (sse += d));
      res.on('error', () => {});
    });
    req.on('error', () => {});
    req.end();
    try {
      const id = await w.session({ title: `title ${KEY}` });                       // a session title
      await w.say(id, `use ${KEY} please`);                                         // a log row, live
      await until(() => w.rows(id, 'turn_ended').length === 1);
      const returned = store.appendLog(id, { type: 'note', data: { text: KEY } }); // a log row, direct
      expect(JSON.stringify(returned)).not.toContain(KEY);
      expect(JSON.stringify(returned.data)).toContain('[key Reins]');

      store.createRun({ id: 'r1', workflowPath: '/w.reins.md', cwd: dir });
      store.appendEvent('r1', { id: 'e1', timestamp: 1, type: 'turn_ended' as any, data: { text: KEY } });  // a run event
      store.saveSnapshot('r1', { note: KEY, events: [{ id: 'e1', data: { text: KEY } }] } as unknown as RunSnapshot);  // a snapshot
      store.putEditorState(dir, JSON.stringify({ text: `draft ${KEY}` }));          // an editor state
      store.putSetting('note', { value: KEY });                                     // a setting
      store.updateSession(id, { title: KEY });

      // what the store holds, read back
      expect(store.getSession(id)!.title).toBe('[key Reins]');
      expect(JSON.parse(store.getEditorState(dir)!)).toEqual({ text: 'draft [key Reins]' });
      expect(store.getSetting('note')).toEqual({ value: '[key Reins]' });
      expect(store.loadRun('r1')!.snapshot).toMatchObject({ note: '[key Reins]' });
      expect(store.loadRun('r1')!.snapshot.events).toEqual([{ id: 'e1', timestamp: 1, type: 'turn_ended', data: { text: '[key Reins]' } }]);

      await until(() => sse.includes('turn_ended'));
      const state = await w.api('GET', '/api/state');
      expect(state.text).not.toContain(KEY);
      expect(sse).toContain('[key Reins]');
      expect(sse).not.toContain(KEY);
    } finally {
      req.destroy();
    }

    // every byte under the home, the database and its write-ahead log included, except the secrets file itself
    const files = filesUnder(dir);
    expect(files.map((f) => path.basename(f.file))).toEqual(expect.arrayContaining(['reins.db', 'secrets.json']));
    for (const f of files) {
      if (path.basename(f.file) === 'secrets.json') continue;
      expect(f.bytes.includes(Buffer.from(KEY)), f.file).toBe(false);
    }
  });

  it('the stream a new client opens (replay of stored rows) carries no key either', async () => {
    const dir = tmpDir();
    setKey(dir, 'p', KEY);
    const store = redactingStore(openStore(':memory:'), noEnv(dir));
    const w = await boot([], { store, dir });
    const id = await w.session();
    store.appendLog(id, { type: 'note', data: { text: `${KEY}` } });
    const s = openStream(w.srv);
    await s.ready;
    await until(() => s.rows.some((r) => r.type === 'note'));
    expect(JSON.stringify(s.rows)).not.toContain(KEY);
    expect(JSON.stringify(s.rows)).toContain('[key Reins]');
  });
});

describe('5. reins run: the terminal output', () => {
  it('neither a command that prints the key (write path) nor a say line that holds it (say path) reaches the output', async () => {
    const t = tempHome();
    try {
      setKey(t.home, 'p', KEY);
      const cwd = tmpDir();
      fs.writeFileSync(path.join(cwd, 'print.mjs'), 'console.log("printed " + process.argv[2]); process.stdout.write("split " + process.argv[2].slice(0, 9)); setTimeout(() => console.log(process.argv[2].slice(9)), 200);');
      const file = path.join(cwd, 'w.reins.md');
      // the command line is echoed by `say` ("$ node print.mjs <key>"); its output goes through `write`
      fs.writeFileSync(file, `---\nreins: 1\nname: leak-check ${KEY}\ntask: print\nbudget: { turns: 5, minutes: 5 }\n---\n\n## run \`node print.mjs ${KEY}\`\n`);
      const input = new PassThrough();
      const output = new PassThrough();
      let text = '';
      output.setEncoding('utf8');
      output.on('data', (d: string) => (text += d));
      const redactor = noEnv(t.home);
      const h = startRunCli({
        file, cwd, input, output, store: redactingStore(openStore(':memory:'), redactor), redactor,
        makeEngine: () => new FakeEngine(),
      });
      const r = await h.done;
      expect(r.exitCode, text).toBe(0);
      expect(text).toContain('printed [key Reins]');                // the write path
      expect(text).toContain('$ node print.mjs [key Reins]');        // the say path
      expect(text).toContain('split [key Reins]');                   // a key cut in two chunks of output is still seen whole
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(KEY.slice(9));
    } finally {
      t.cleanup();
    }
  });
});

describe('6. childEnv', () => {
  const env = { PATH: process.env.PATH ?? '/bin', X_API_KEY: KEY, Y_TOKEN: 'tok-test-0123456789', REINS_HOME: '/h', REINS_CLAUDE: 'c', KEEP: 'yes', SystemRoot: process.env.SystemRoot };

  it('drops every installed keyEnv name and REINS_*, keeps PATH and the rest, and never adds a stored key', () => {
    const t = tempHome();
    try {
      setKey(t.home, 'p', 'from-secrets-file-1');
      const out = childEnv(env, ['X_API_KEY', 'Y_TOKEN']);
      expect(out.X_API_KEY).toBeUndefined();
      expect(out.Y_TOKEN).toBeUndefined();
      expect(Object.keys(out).filter((k) => k.startsWith('REINS_'))).toEqual([]);
      expect(out.PATH).toBe(env.PATH);
      expect(out.KEEP).toBe('yes');
      expect(JSON.stringify(out)).not.toContain('from-secrets-file-1');
      expect(env.X_API_KEY).toBe(KEY);                                // a copy: the input is untouched
      expect(childEnv(env, [])).toMatchObject({ X_API_KEY: KEY });    // only installed names are dropped
    } finally {
      t.cleanup();
    }
  });

  it('a workflow command through the real runCommand does not see the key or a REINS_ var', async () => {
    const cwd = tmpDir();
    const node = JSON.stringify(process.execPath);
    const print = (name: string) => runCommand(`${node} -e "console.log(process.env.${name} ?? 'none')"`, { cwd, env: childEnv(env, ['X_API_KEY']) });
    expect((await print('X_API_KEY')).stdout.trim()).toBe('none');
    expect((await print('REINS_HOME')).stdout.trim()).toBe('none');
    expect((await print('KEEP')).stdout.trim()).toBe('yes');
    // the control: with the env as given the same command prints the key, so the test can fail
    const raw = await runCommand(`${node} -e "console.log(process.env.X_API_KEY ?? 'none')"`, { cwd, env });
    expect(raw.stdout.trim()).toBe(KEY);
  });
});

describe('doctor and problem lines', () => {
  it('doctor --no-probe hides a key that a mod problem line echoes', async () => {
    const t = tempHome();
    try {
      const reins = path.join(t.home, '.reins');
      fs.mkdirSync(path.join(reins, 'mods', 'bad'), { recursive: true });
      fs.writeFileSync(path.join(reins, 'mods', 'bad', 'mod.json'), JSON.stringify({
        reins: 1, id: 'bad', kind: 'provider', version: '1.0.0', label: 'Bad', protocol: 'claude-code-cli', baseUrl: KEY, defaultModel: 'm', models: [{ id: 'm' }],
      }));
      const run = async () => {
        const stdout = new PassThrough();
        let out = '';
        stdout.on('data', (d) => (out += d));
        const code = await main(['doctor', '--no-probe'], { stdout, stderr: new PassThrough(), stdin: new PassThrough(), env: { ...process.env, REINS_HOME: t.home } });
        return { code, out };
      };
      const before = await run();
      expect(before.out).toContain(KEY);                              // the premise: the loader does echo the value
      setKey(reins, 'p', KEY);
      const after = await run();
      expect(after.out).not.toContain(KEY);
      expect(after.out).toContain('[key Reins]');
      expect(after.out).toMatch(/mod\s+bad/);
    } finally {
      t.cleanup();
    }
  }, 60_000);

  it('the server hides a key in the problem lines a probe returns or throws', async () => {
    const dir = tmpDir();
    setKey(dir, 'p', KEY);
    const redactor = noEnv(dir);
    let throws = false;
    const srv = await startServer({
      store: openStore(':memory:'), dir, redactor, makeEngine: () => { throw new Error('none'); },
      probe: async () => {
        if (throws) throw new Error(`probe failed with ${KEY}`);
        return { installed: true, loggedIn: true, version: `v ${KEY}`, capabilities: { midTurnSteer: 'none', preToolDeny: false, resume: false }, problems: [`bad ${KEY}`] };
      },
    });
    try {
      const r = await request(srv, 'POST', '/api/state/probe');
      expect(r.status).toBe(200);
      expect(r.text).toContain('"version":"v [key Reins]"');       // the whole answer is cleaned, not only the problem lines
      expect(r.text).toContain('bad [key Reins]');
      expect(r.text).not.toContain(KEY);
      throws = true;
      const t = await request(srv, 'POST', '/api/state/probe');
      expect(t.text).toContain('probe failed with [key Reins]');
      expect(t.text).not.toContain(KEY);
    } finally {
      await srv.close();
    }
  });
});


describe('7. overlapping secrets: the union of every match is replaced', () => {
  const A = 'abcdefghABCDEFGH';
  const B = 'ABCDEFGHABCDEFGH';
  const mk = (env: Record<string, string>) => new Redactor({ home: tmpDir(), env, keyEnvNames: () => Object.keys(env) });

  it('two secrets that overlap leave no raw piece of either: one marker, the one of the first of the longest', () => {
    expect(mk({ A_API_KEY: A, B_API_KEY: B }).redact(`${A}ABCDEFGH!`)).toBe('[key A_API_KEY]!');
    expect(mk({ B_API_KEY: B, A_API_KEY: A }).redact(`${A}ABCDEFGH!`)).toBe('[key B_API_KEY]!');
    expect(mk({ A_API_KEY: A, B_API_KEY: B }).redact(`x ${A}ABCDEFGH`)).toBe('x [key A_API_KEY]');
  });

  it('a secret that overlaps itself is found at every offset, so no raw piece of it is left', () => {
    // 'abababab' occurs at 0, 2 and 4 inside 12 characters; skipping a whole key length after a hit would leave 'abab' raw.
    const S = 'abababab';
    expect(mk({ S_API_KEY: S }).redact('-abababababab-')).toBe('-[key S_API_KEY]-');
  });

  it('a chain of three overlapping secrets is one range', () => {
    const X = 'aaaaaaaabbbbbbbb';
    const Y = 'bbbbbbbbcccccccc';
    const Z = 'ccccccccdddddddd';
    expect(mk({ X_API_KEY: X, Y_API_KEY: Y, Z_API_KEY: Z }).redact('-aaaaaaaabbbbbbbbccccccccdddddddd-')).toBe('-[key X_API_KEY]-');
  });

  it('secrets that only touch stay two markers; a short secret inside a long one gives the long one', () => {
    expect(mk({ X_API_KEY: 'aaaaaaaa', Y_API_KEY: 'bbbbbbbb' }).redact('aaaaaaaabbbbbbbb')).toBe('[key X_API_KEY][key Y_API_KEY]');
    const r = mk({ S_API_KEY: 'abcdefgh', L_API_KEY: 'abcdefghijklmnop' });
    expect(r.redact('abcdefghijklmnop and abcdefgh')).toBe('[key L_API_KEY] and [key S_API_KEY]');
  });

  it('redactJson and a key inside a JSON string follow the same rule', () => {
    expect(mk({ A_API_KEY: A, B_API_KEY: B }).redactJson({ a: `${A}ABCDEFGH!`, b: [`${A}ABCDEFGH`] })).toEqual({ a: '[key A_API_KEY]!', b: ['[key A_API_KEY]'] });
  });

  it('redactCut holds back a partial key at the end even when the text is shorter than max, and masks the overlap before the cap', () => {
    const r = mk({ A_API_KEY: A, B_API_KEY: B });
    expect(redactCut(r, 'blah abcdefghABC', 100)).toBe('blah ');
    expect(redactCut(r, 'blah abcdefghABC')).toBe('blah ');
    expect(redactCut(r, `${A}ABCDEFGH!`, 100)).toBe('[key A_API_KEY]!');
  });

  it('a stream split at any point never shows the overlapped tail', () => {
    const text = `ok ${A}ABCDEFGH! done`;
    for (let cut = 1; cut < text.length; cut++) {
      const s = new StreamRedactor(mk({ A_API_KEY: A, B_API_KEY: B }));
      const out = s.push(text.slice(0, cut)) + s.push(text.slice(cut)) + s.end();
      expect(out, `cut at ${cut}`).toBe('ok [key A_API_KEY]! done');
    }
  });

  it('is not slow: 10000 redact calls on a 200-character text with 3 secrets, with and without a hit', () => {
    const r = mk({ A_API_KEY: 'sk-aaaaaaaaaaaa-0001', B_API_KEY: 'sk-bbbbbbbbbbbb-0002', C_API_KEY: 'sk-cccccccccccc-0003' });
    const hit = `${'x'.repeat(90)} sk-bbbbbbbbbbbb-0002 ${'y'.repeat(88)}`;
    const miss = 'z'.repeat(200);
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) {
      r.redact(hit);
      r.redact(miss);
    }
    expect(performance.now() - t0).toBeLessThan(5000); // about 0.5 s on a laptop: the bound only catches a change of order of growth
    expect(r.redact(hit)).toContain('[key B_API_KEY]');
  });
});