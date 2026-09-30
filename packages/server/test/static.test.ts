import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';
import { openStore } from '../src/store.js';
import { PROBE, cleanup, tmpDir } from './http-helpers.js';

afterEach(cleanup);

interface Got { status: number; headers: http.IncomingHttpHeaders; text: string }
function raw(port: number, method: string, url: string, headers: Record<string, string> = {}): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, agent: false, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function boot(withApp = true) {
  const root = tmpDir();
  const appDir = path.join(root, 'app');
  fs.mkdirSync(path.join(appDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'index.html'), '<!doctype html><title>app</title>');
  fs.writeFileSync(path.join(appDir, 'assets', 'a.js'), 'export const a = 1;');
  fs.writeFileSync(path.join(appDir, 'assets', 'a.css'), 'body{}');
  fs.writeFileSync(path.join(appDir, 'assets', 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(appDir, 'assets', 'a.bin'), 'x');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'SECRET');
  const store = openStore(':memory:');
  const srv = await startServer({
    store, dir: tmpDir(), probe: async () => PROBE, makeEngine: () => { throw new Error('unused'); },
    ...(withApp ? { appDir } : {}),
  });
  return { srv, get: (url: string, headers?: Record<string, string>, method = 'GET') => raw(srv.port, method, url, headers), root };
}
const closeAfter = (srv: { close(): Promise<void> }) => srv.close();

describe('static serving', () => {
  it('serves index.html at / with no token', async () => {
    const w = await boot();
    const r = await w.get('/');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.text).toContain('<title>app</title>');
    await closeAfter(w.srv);
  });

  it('serves assets with the exact content types', async () => {
    const w = await boot();
    expect((await w.get('/assets/a.js')).headers['content-type']).toBe('text/javascript');
    expect((await w.get('/assets/a.css')).headers['content-type']).toBe('text/css');
    expect((await w.get('/assets/a.svg')).headers['content-type']).toBe('image/svg+xml');
    expect((await w.get('/assets/a.bin')).headers['content-type']).toBe('application/octet-stream');
    expect((await w.get('/assets/a.js')).text).toBe('export const a = 1;');
    await closeAfter(w.srv);
  });

  it.each([
    ['an unknown path', '/nope.js'],
    ['a folder', '/assets'],
    ['a folder with a slash', '/assets/'],
    ['%2f traversal to a real file', '/..%2fsecret.txt'],
    ['%2f traversal up twice', '/..%2f..%2fpackage.json'],
    ['%5c traversal to a real file', '/..%5csecret.txt'],
    ['%5c traversal to windows', '/..%5c..%5cWindows%5cwin.ini'],
    ['a drive path', '/C:/Windows/win.ini'],
    ['a NUL byte', '/%00.js'],
    ['a broken percent escape', '/%E0%A4%A.js'],
    ['no SPA fallback', '/some/route'],
  ])('404 for %s', async (_n, url) => {
    const w = await boot();
    const r = await w.get(url);
    expect(r.status).toBe(404);
    expect(r.text).not.toContain('SECRET');
    await closeAfter(w.srv);
  });

  it('404 for a non-GET outside /api/', async () => {
    const w = await boot();
    expect((await w.get('/', {}, 'PUT')).status).toBe(404);
    expect((await w.get('/', {}, 'POST')).status).toBe(404);
    await closeAfter(w.srv);
  });

  it('a bad Host is 403 before the static route', async () => {
    const w = await boot();
    expect((await w.get('/', { host: 'evil.example:80' })).status).toBe(403);
    expect((await w.get('/', { origin: 'http://evil.example' })).status).toBe(403);
    await closeAfter(w.srv);
  });

  it('without appDir the root is still 404', async () => {
    const w = await boot(false);
    expect((await w.get('/')).status).toBe(404);
    await closeAfter(w.srv);
  });

  it('sends the security headers on a static and an API response', async () => {
    const w = await boot();
    for (const url of ['/', '/nope', '/api/state']) {
      const h = (await w.get(url)).headers;
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['content-security-policy']).toBe("default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      expect(h['referrer-policy']).toBe('no-referrer');
    }
    await closeAfter(w.srv);
  });
});
