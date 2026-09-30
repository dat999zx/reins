import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { takeLock } from '../src/lock.js';
import { URL_PATTERN, openUrl } from '../src/opener.js';
import { FAKE_CLAUDE, fakeSetup, until } from './helpers.js';
import { cleanup, tmpDir } from './http-helpers.js';

afterEach(cleanup);

const TOKEN = 'ab'.repeat(32);
const URL_OK = `http://127.0.0.1:4242/#token=${TOKEN}`;

function fakeSpawn() {
  const calls: Array<{ cmd: string; args: string[]; options: Record<string, unknown> }> = [];
  let unrefs = 0;
  const child = Object.assign(new EventEmitter(), { unref: () => { unrefs++; } });
  const spawn = (cmd: string, args: string[], options: Record<string, unknown>) => { calls.push({ cmd, args, options }); return child; };
  return { spawn, calls, child, unrefs: () => unrefs };
}

describe('the URL pattern', () => {
  it('accepts only http://127.0.0.1:<port>/#token=<64 hex>', () => {
    expect(URL_PATTERN.test(URL_OK)).toBe(true);
    for (const bad of [
      `${URL_OK} `, ` ${URL_OK}`, `${URL_OK}&calc`, `${URL_OK}"`, `${URL_OK}%41`, `${URL_OK}^`, `${URL_OK}|x`, `${URL_OK}<x>`,
      `${URL_OK}\n`, `http://localhost:4242/#token=${TOKEN}`, `https://127.0.0.1:4242/#token=${TOKEN}`,
      `http://127.0.0.1:4242/#token=${TOKEN.slice(1)}`, `http://127.0.0.1:4242/#token=${TOKEN.toUpperCase()}`,
      `http://127.0.0.1:/#token=${TOKEN}`, `http://127.0.0.1:4242/x#token=${TOKEN}`,
    ]) expect(URL_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe('openUrl', () => {
  it('win32: cmd /c start "" <url>, detached, no shell, unref', () => {
    const f = fakeSpawn();
    openUrl(URL_OK, { platform: 'win32', dir: tmpDir(), spawn: f.spawn, err: () => {} });
    expect(f.calls).toEqual([{ cmd: 'cmd', args: ['/c', 'start', '', URL_OK], options: { shell: false, detached: true, stdio: 'ignore', windowsHide: true } }]);
    expect(f.unrefs()).toBe(1);
  });

  it.each([['darwin', 'open'], ['linux', 'xdg-open']])('%s: the URL is never an argument; open.html holds it and its path is opened', (platform, cmd) => {
    const dir = tmpDir();
    const f = fakeSpawn();
    openUrl(URL_OK, { platform, dir, spawn: f.spawn, err: () => {} });
    const file = path.join(dir, 'open.html');
    expect(f.calls).toEqual([{ cmd, args: [file], options: { shell: false, detached: true, stdio: 'ignore', windowsHide: true } }]);
    expect(f.calls.flatMap((c) => c.args).join(' ')).not.toContain('token');
    const html = fs.readFileSync(file, 'utf8');
    expect(html).toContain(`<meta http-equiv="refresh" content="0;url=${URL_OK}">`);
    expect(html).toContain(`<a href="${URL_OK}">`);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(f.unrefs()).toBe(1);
  });

  it('a platform with no entry spawns nothing and writes nothing', () => {
    const dir = tmpDir();
    const f = fakeSpawn();
    openUrl(URL_OK, { platform: 'freebsd', dir, spawn: f.spawn, err: () => {} });
    expect(f.calls).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('a URL that fails the check is never spawned and is printed for pasting', () => {
    const f = fakeSpawn();
    const lines: string[] = [];
    const bad = `http://127.0.0.1:4242/#token=${TOKEN}&calc`;
    for (const platform of ['win32', 'linux', 'darwin']) openUrl(bad, { platform, dir: tmpDir(), spawn: f.spawn, err: (l) => lines.push(l) });
    expect(f.calls).toEqual([]);
    expect(lines).toEqual(Array(3).fill(`Open this address in your browser: ${bad}`));
  });

  it("a spawn 'error' (no xdg-open) prints the address instead of throwing", () => {
    const f = fakeSpawn();
    const lines: string[] = [];
    openUrl(URL_OK, { platform: 'linux', dir: tmpDir(), spawn: f.spawn, err: (l) => lines.push(l) });
    expect(lines).toEqual([]);
    f.child.emit('error', new Error('spawn xdg-open ENOENT'));
    expect(lines).toEqual([`Open this address in your browser: ${URL_OK}`]);
  });
});

function run(argv: string[], home: string, open?: (url: string) => void) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (d) => (out += d));
  stderr.on('data', (d) => (err += d));
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => { stop = resolve; });
  const done = main(argv, {
    stdout, stderr, stdin: new PassThrough(), stop: stopped, ...(open ? { open } : {}),
    env: { ...process.env, REINS_HOME: home, REINS_CLAUDE: FAKE_CLAUDE },
  });
  return { done, stop, out: () => out, err: () => err };
}

const ADDRESS = /http:\/\/127\.0\.0\.1:(\d+)\/#token=([0-9a-f]{64})/;

describe('bare reins', () => {
  it('serves, opens the printed URL once, and prints the paste hint', async () => {
    fakeSetup([]);
    const opened: string[] = [];
    const s = run([], tmpDir(), (u) => opened.push(u));
    await until(() => opened.length === 1);
    expect(opened[0]).toBe(ADDRESS.exec(s.out())![0]);
    expect(s.out()).toContain('If the browser cannot open the page, paste the address above.');
    s.stop();
    expect(await s.done).toBe(0);
    expect(opened).toHaveLength(1);
  }, 30_000);

  it('with a server already running it opens that address and exits 0', async () => {
    const home = tmpDir();
    fs.mkdirSync(path.join(home, '.reins'), { recursive: true });
    expect(takeLock(path.join(home, '.reins', 'serve.lock'), { pid: process.pid, port: 4242, token: TOKEN })).toEqual({ ok: true });
    const opened: string[] = [];
    const s = run([], home, (u) => opened.push(u));
    expect(await s.done).toBe(0);
    expect(opened).toEqual([URL_OK]);
    expect(s.out()).toContain(URL_OK);
  });

  it('reins serve does not open anything, and its already-running exit stays 1', async () => {
    const home = tmpDir();
    fs.mkdirSync(path.join(home, '.reins'), { recursive: true });
    expect(takeLock(path.join(home, '.reins', 'serve.lock'), { pid: process.pid, port: 4242, token: TOKEN })).toEqual({ ok: true });
    const opened: string[] = [];
    const s = run(['serve'], home, (u) => opened.push(u));
    expect(await s.done).toBe(1);
    expect(opened).toEqual([]);
  });

  it('the usage text lists bare reins', async () => {
    const s = run(['nonsense'], tmpDir());
    expect(await s.done).toBe(1);
    expect(s.err()).toMatch(/^\s*reins\s+\(/m);
  });
});
