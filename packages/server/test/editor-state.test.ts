import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/store.js';
import { boot, cleanup, tmpDir } from './http-helpers.js';

afterEach(cleanup);

const URL_ = '/api/editor-state';
const get = (w: Awaited<ReturnType<typeof boot>>, cwd: string, auth = true) => w.api('GET', `${URL_}?cwd=${encodeURIComponent(cwd)}`, { auth });
const put = (w: Awaited<ReturnType<typeof boot>>, body: unknown) => w.api('PUT', URL_, { body });
const STATE = { workflow: 'D:\\p\\a.reins.md', tab: 'text', stepId: 'build' };

describe('store editor state', () => {
  it('round-trips, keeps the second put, and gives undefined for an unknown cwd', () => {
    const s = openStore(':memory:');
    expect(s.getEditorState('/a')).toBeUndefined();
    s.putEditorState('/a', '{"tab":"chat"}');
    expect(s.getEditorState('/a')).toBe('{"tab":"chat"}');
    s.putEditorState('/a', '{"tab":"text"}');
    expect(s.getEditorState('/a')).toBe('{"tab":"text"}');
    expect(s.getEditorState('/b')).toBeUndefined();
    s.close();
  });

  it('survives a close and reopen of a file db', () => {
    const file = path.join(tmpDir(), 'reins.db');
    const a = openStore(file);
    a.putEditorState('/a', '{"x":1}');
    a.close();
    const b = openStore(file);
    expect(b.getEditorState('/a')).toBe('{"x":1}');
    b.close();
  });
});

describe('editor state over HTTP', () => {
  it('GET needs an absolute cwd; an unknown cwd is {state:null}; no token is 401', async () => {
    const w = await boot();
    expect((await w.api('GET', URL_)).status).toBe(400);
    expect((await get(w, 'rel/dir')).status).toBe(400);
    const r = await get(w, w.cwd);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ state: null });
    expect((await get(w, w.cwd, false)).status).toBe(401);
    expect((await w.api('PUT', URL_, { body: { cwd: w.cwd, state: {} }, auth: false })).status).toBe(401);
  });

  it('PUT then GET returns the same object, and the folder need not exist', async () => {
    const w = await boot();
    expect((await put(w, { cwd: w.cwd, state: STATE })).json).toEqual({});
    expect((await get(w, w.cwd)).json).toEqual({ state: STATE });
    const gone = path.join(w.cwd, 'not-there');
    expect((await put(w, { cwd: gone, state: { tab: 'chat' } })).status).toBe(200);
    expect((await get(w, gone)).json).toEqual({ state: { tab: 'chat' } });
    expect((await get(w, w.cwd)).json).toEqual({ state: STATE });
  });

  it.each([['an array', []], ['a string', 'x'], ['null', null], ['missing', undefined]])('PUT with state %s is 400', async (_n, state) => {
    const w = await boot();
    expect((await put(w, { cwd: w.cwd, ...(state === undefined ? {} : { state }) })).status).toBe(400);
    expect((await get(w, w.cwd)).json).toEqual({ state: null });
  });

  it('PUT with a relative or missing cwd is 400', async () => {
    const w = await boot();
    expect((await put(w, { cwd: 'rel/dir', state: {} })).status).toBe(400);
    expect((await put(w, { state: {} })).status).toBe(400);
  });

  it('PUT over 64 KB is 413 and stores nothing; just under is fine', async () => {
    const w = await boot();
    const big = { pad: 'x'.repeat(65_536) };
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(65_536);
    expect((await put(w, { cwd: w.cwd, state: big })).status).toBe(413);
    expect((await get(w, w.cwd)).json).toEqual({ state: null });
    const fits = { pad: 'x'.repeat(60_000) };
    expect((await put(w, { cwd: w.cwd, state: fits })).status).toBe(200);
  });

  it('the cwd key is normalised: trailing slash, and case on Windows', async () => {
    const w = await boot();
    if (process.platform === 'win32') {
      expect((await put(w, { cwd: 'D:\\x', state: STATE })).status).toBe(200);
      expect((await get(w, 'd:\\x\\')).json).toEqual({ state: STATE });
    } else {
      expect((await put(w, { cwd: '/tmp/x', state: STATE })).status).toBe(200);
      expect((await get(w, '/tmp/x/')).json).toEqual({ state: STATE });
    }
  });

  it('a restart on the same db file reads the same state back', async () => {
    const dir = tmpDir();
    const file = path.join(tmpDir(), 'reins.db');
    const w1 = await boot([], { store: openStore(file), dir });
    expect((await put(w1, { cwd: w1.cwd, state: STATE })).status).toBe(200);
    await w1.srv.close();
    w1.store.close();
    const w2 = await boot([], { store: openStore(file), dir, fake: w1.fake });
    expect((await get(w2, w2.cwd)).json).toEqual({ state: STATE });
  });

  it('a corrupt stored row gives {state:null}, not a 500', async () => {
    const dir = tmpDir();
    const file = path.join(tmpDir(), 'reins.db');
    const w = await boot([], { store: openStore(file), dir });
    await put(w, { cwd: w.cwd, state: STATE });
    const db = new DatabaseSync(file);
    db.exec("update editor_state set json = '{not json'");
    db.close();
    const r = await get(w, w.cwd);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ state: null });
  });
});
