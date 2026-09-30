import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type ServerOptions } from '../src/server.js';
import { openStore } from '../src/store.js';
import { PROBE, cleanup, request, tmpDir, type Res } from './http-helpers.js';
import { until } from './helpers.js';

afterEach(cleanup);

async function boot(pickFolder?: ServerOptions['pickFolder']) {
  const srv = await startServer({
    store: openStore(':memory:'), dir: tmpDir(), probe: async () => PROBE,
    makeEngine: () => { throw new Error('unused'); },
    ...(pickFolder ? { pickFolder } : {}),
  });
  const pick = () => request(srv, 'POST', '/api/pick-folder');
  return { srv, pick };
}

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

describe('POST /api/pick-folder', () => {
  it('returns { path } for a picked folder', async () => {
    const dir = tmpDir();
    const x = await boot(async () => dir);
    const r = await x.pick();
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ path: dir });
  });

  it('needs the token', async () => {
    const x = await boot(async () => tmpDir());
    expect((await request(x.srv, 'POST', '/api/pick-folder', { auth: false })).status).toBe(401);
  });

  it('returns { cancelled: true } for a cancel', async () => {
    const x = await boot(async () => null);
    const r = await x.pick();
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ cancelled: true });
  });

  it('a picked path that is not an existing absolute folder is cancelled', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'f.txt');
    fs.writeFileSync(file, 'x');
    for (const bad of [file, path.join(dir, 'missing'), 'relative/folder', '']) {
      const x = await boot(async () => bad);
      expect((await x.pick()).json).toEqual({ cancelled: true });
    }
  });

  it('501 without a picker, and 501 with the message of a picker that rejects', async () => {
    const none = await boot();
    const a = await none.pick();
    expect(a.status).toBe(501);
    expect(typeof a.json.error).toBe('string');
    const broken = await boot(async () => { throw new Error('no folder picker found'); });
    const b = await broken.pick();
    expect(b.status).toBe(501);
    expect(b.json).toEqual({ error: 'no folder picker found' });
  });

  it('409 for a second call while the first dialog is open, then it works again', async () => {
    const gate = deferred<string | null>();
    let calls = 0;
    const dir = tmpDir();
    const x = await boot(() => (++calls === 1 ? gate.promise : Promise.resolve(dir)));
    const first = x.pick();
    await until(() => calls === 1);
    const second = await x.pick();
    expect(second.status).toBe(409);
    expect(typeof second.json.error).toBe('string');
    expect(calls).toBe(1);
    gate.resolve(dir);
    expect((await first).json).toEqual({ path: dir });
    expect((await x.pick()).json).toEqual({ path: dir });
  });

  it('aborts the signal when the client drops the request, and frees the 409', async () => {
    const signals: AbortSignal[] = [];
    const dir = tmpDir();
    const x = await boot((signal) => {
      signals.push(signal);
      return signals.length === 1
        ? new Promise<string | null>((resolve) => signal.addEventListener('abort', () => resolve(null)))
        : Promise.resolve(dir);
    });
    const req = http.request({
      host: '127.0.0.1', port: x.srv.port, path: '/api/pick-folder', method: 'POST', agent: false,
      headers: { authorization: `Bearer ${x.srv.token}` },
    });
    req.on('error', () => {});
    req.end();
    await until(() => signals.length === 1);
    expect(signals[0]!.aborted).toBe(false);
    req.destroy();
    await until(() => signals[0]!.aborted);
    let again: Res = await x.pick();
    for (let i = 0; i < 50 && again.status === 409; i++) {
      await new Promise((r) => setTimeout(r, 20));
      again = await x.pick();
    }
    expect(again.json).toEqual({ path: dir });
  });

  it('server.close() aborts a dialog that is still open', async () => {
    let seen: AbortSignal | undefined;
    const x = await boot((signal) => {
      seen = signal;
      return new Promise<string | null>((resolve) => signal.addEventListener('abort', () => resolve(null)));
    });
    const pending = x.pick().catch(() => undefined);
    await until(() => seen !== undefined);
    await x.srv.close();
    await until(() => seen!.aborted);
    await pending;
  });
});
