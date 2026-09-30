// `reins serve` (plan 15d 3b.3 line 1396, 3b.6 lines 1500-1516), in-process through main().
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { main } from '../src/cli.js';
import { takeLock } from '../src/lock.js';
import { openStore } from '../src/store.js';
import { FAKE_CLAUDE, fakeSetup, until } from './helpers.js';
import { cleanup, request, tmpDir } from './http-helpers.js';

afterEach(cleanup);

function serve(argv: string[], home: string) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (d) => (out += d));
  stderr.on('data', (d) => (err += d));
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => { stop = resolve; });
  const done = main(argv, {
    stdout, stderr, stdin: new PassThrough(), stop: stopped,
    env: { ...process.env, REINS_HOME: home, REINS_CLAUDE: FAKE_CLAUDE },
  });
  return { done, stop, out: () => out, err: () => err };
}

const ADDRESS = /http:\/\/127\.0\.0\.1:(\d+)\/#token=([0-9a-f]{64})/;

describe('reins serve', () => {
  it('starts, prints the address with the token, holds serve.lock, and stopping releases it', async () => {
    fakeSetup([]);
    const home = tmpDir();
    const s = serve(['serve', '--port', '0'], home);
    await until(() => ADDRESS.test(s.out()));
    const [, port, token] = ADDRESS.exec(s.out())!;
    const lockFile = path.join(home, '.reins', 'serve.lock');
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8'))).toEqual({ pid: process.pid, port: Number(port), token });
    const me = { port: Number(port), token: token! };
    const state = await request(me, 'GET', '/api/state');
    expect(state.status).toBe(200);
    expect(state.json.engines[0]).toMatchObject({ id: 'claude', installed: true, version: '2.1.281' });
    expect(fs.existsSync(path.join(home, '.reins', 'reins.db'))).toBe(true);
    s.stop();
    expect(await s.done).toBe(0);
    expect(fs.existsSync(lockFile)).toBe(false);
    await expect(request(me, 'GET', '/api/state')).rejects.toThrow();
  }, 30_000);

  it("a second instance prints the running one's address, exits 1, and writes nothing", async () => {
    const home = tmpDir();
    const dbFile = path.join(home, '.reins', 'reins.db');
    const lockFile = path.join(home, '.reins', 'serve.lock');
    const seed = openStore(dbFile);
    seed.createSession({ id: 's1', cwd: home, engine: 'claude' });
    seed.appendLog('s1', { type: 'question', data: { id: 'q', kind: 'tool', prompt: 'p' } });
    seed.close();
    expect(takeLock(lockFile, { pid: process.pid, port: 4242, token: 'tok' })).toEqual({ ok: true });
    const s = serve(['serve'], home);
    expect(await s.done).toBe(1);
    expect(s.out()).toContain('http://127.0.0.1:4242/#token=tok');
    expect(s.err()).toMatch(/already/i);
    const again = openStore(dbFile);
    expect(again.readLog('s1').map((r) => r.type)).toEqual(['question']);
    again.close();
    expect(fs.existsSync(lockFile)).toBe(true);
  });

  it('a second instance on the same fixed port names the first instead of failing on EADDRINUSE', async () => {
    const home = tmpDir();
    const a = serve(['serve'], home);
    await until(() => ADDRESS.test(a.out()));
    const [, port, token] = ADDRESS.exec(a.out())!;
    const b = serve(['serve', '--port', port!], home);
    expect(await b.done).toBe(1);
    expect(b.out()).toContain(`http://127.0.0.1:${port}/#token=${token}`);
    expect(b.err()).toMatch(/already/i);
    expect(b.err()).not.toMatch(/EADDRINUSE/);
    a.stop();
    expect(await a.done).toBe(0);
  });

  it('--port must be a whole number from 0 to 65535, and nothing starts otherwise', async () => {
    const home = tmpDir();
    for (const bad of [['--port', 'abc'], ['--port', '-1'], ['--port', '1.5'], ['--port', '70000'], ['--port']]) {
      const s = serve(['serve', ...bad], home);
      expect(await s.done, bad.join(' ')).toBe(1);
      expect(s.err()).toContain('--port');
      expect(s.out()).toBe('');
    }
    expect(fs.existsSync(path.join(home, '.reins', 'serve.lock'))).toBe(false);
  });
});
