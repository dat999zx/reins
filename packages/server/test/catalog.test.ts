import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCatalog } from '../src/catalog.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const DATA = {
  acme: {
    models: {
      'm-1': {
        name: 'M One', release_date: '2026-01-01', tool_call: true, limit: { context: 1000, output: 10 },
        cost: {
          input: 1, output: 2, cache_read: 0.1, cache_write: 1.25,
          tiers: [{ input: 3, tier: { type: 'context', size: 100 } }, { input: 9, tier: { type: 'time', size: 5 } }],
        },
      },
    },
  },
};
const OTHER = { acme: { models: { 'm-2': { name: 'M Two' } } } };

function setup(content?: unknown, ageMs = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-cat-'));
  dirs.push(dir);
  const file = path.join(dir, 'cache.json');
  if (content !== undefined) {
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(file, t, t);
  }
  return { dir, file };
}
const reply = (body: unknown, status = 200) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const HOUR = 3_600_000;

describe('createCatalog', () => {
  it('reads the fields it knows and gives each model an id', () => {
    const { file } = setup(DATA);
    const c = createCatalog({ file });
    expect(c.models('acme')).toEqual([{
      id: 'm-1', label: 'M One', released: '2026-01-01', toolCall: true, context: 1000, output: 10,
      price: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25, tiers: [{ size: 100, input: 3 }] },
    }]);
    expect(c.models('nope')).toEqual([]);
  });

  it('a field of the wrong type is dropped, the rest stays', () => {
    const { file } = setup({ acme: { models: { x: { name: 5, tool_call: 'yes', limit: { context: '1000', output: 10 }, cost: { input: 1, output: 2 } } } } });
    expect(createCatalog({ file }).models('acme')).toEqual([{ id: 'x', label: 'x', output: 10, price: { input: 1, output: 2 } }]);
  });

  it('models() does no I/O after its first call, and never fetches', () => {
    const { file } = setup(DATA, 10 * HOUR);
    const fetch = vi.fn(reply(OTHER));
    const c = createCatalog({ file, fetch });
    expect(c.models('acme')).toHaveLength(1);
    fs.writeFileSync(file, JSON.stringify(OTHER));
    expect(c.models('acme')[0]!.id).toBe('m-1');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a copy under 4 hours is not refetched; an older one is, and the old copy is served meanwhile', async () => {
    const fresh = setup(DATA, 3 * HOUR);
    const noFetch = vi.fn(reply(OTHER));
    await createCatalog({ file: fresh.file, fetch: noFetch }).refresh();
    expect(noFetch).not.toHaveBeenCalled();

    const old = setup(DATA, 5 * HOUR);
    let release!: (r: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((r) => { release = r; }));
    const c = createCatalog({ file: old.file, fetch });
    const done = c.refresh();
    expect(c.models('acme')[0]!.id).toBe('m-1');
    release(new Response(JSON.stringify(OTHER)));
    await done;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(c.models('acme')[0]!.id).toBe('m-2');
    expect(JSON.parse(fs.readFileSync(old.file, 'utf8'))).toEqual(OTHER);
  });

  it('a failed refresh blocks another for 5 minutes, then allows it', async () => {
    const { file } = setup();
    let t = 1_000_000;
    const fetch = vi.fn(async (): Promise<Response> => { throw new Error('offline'); });
    const c = createCatalog({ file, fetch, now: () => t });
    await c.refresh();
    await c.refresh();
    expect(fetch).toHaveBeenCalledTimes(1);
    t += 5 * 60_000 - 1;
    await c.refresh();
    expect(fetch).toHaveBeenCalledTimes(1);
    t += 2;
    await c.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('one refresh is in flight: a second call returns the same promise and fetches once', async () => {
    const { file } = setup();
    const fetch = vi.fn(reply(DATA));
    const c = createCatalog({ file, fetch });
    const a = c.refresh();
    const b = c.refresh();
    expect(b).toBe(a);
    await a;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a corrupt or non-object file is renamed and read as empty', () => {
    for (const text of ['{not json', '[1,2]']) {
      const { file } = setup(text);
      expect(createCatalog({ file }).models('acme')).toEqual([]);
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.readFileSync(`${file}.corrupt`, 'utf8')).toBe(text);
    }
  });

  it('refresh() resolves and never rejects: fetch throws, 500, a non-object body, or a rename that throws', async () => {
    const cases: Array<[string, () => Promise<Response>]> = [
      ['throws', async () => { throw new Error('boom'); }],
      ['500', reply({}, 500)],
      ['array', reply('[1]')],
      ['not json', reply('<html>')],
    ];
    for (const [, fetch] of cases) {
      const { file } = setup();
      await expect(createCatalog({ file, fetch }).refresh()).resolves.toBeUndefined();
    }
    const { dir, file } = setup();
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); });
    const c = createCatalog({ file, fetch: reply(DATA) });
    await expect(c.refresh()).resolves.toBeUndefined();
    expect(c.models('acme')[0]!.id).toBe('m-1');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('close() aborts a pending fetch', async () => {
    const { file } = setup();
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const c = createCatalog({ file, fetch: fetch as unknown as typeof globalThis.fetch });
    const done = c.refresh();
    await new Promise((r) => setTimeout(r, 0));
    c.close();
    // close() itself aborts: well inside the 10 s fetch timeout, which would also end it (and pass a weaker test)
    await expect(Promise.race([done, new Promise((r) => setTimeout(() => r('late'), 2000))])).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
  });

  it('an answer that is not 200 keeps the old copy, even with a valid body', async () => {
    const { file } = setup(DATA, 10 * HOUR);
    const c = createCatalog({ file, fetch: reply(OTHER, 503) });
    await c.refresh();
    expect(c.models('acme').map((m) => m.id)).toEqual(['m-1']);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(DATA);
  });

  it('with no fetch there is no network: refresh resolves at once and the file is served', async () => {
    const { file } = setup(DATA, 10 * HOUR);
    const c = createCatalog({ file });
    await c.refresh();
    expect(c.models('acme')).toHaveLength(1);
  });
});
