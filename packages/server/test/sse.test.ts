import { describe, expect, it } from 'vitest';
import { parseSse } from '../src/loop/sse.js';

const enc = new TextEncoder();
const bytes = (parts: Array<string | Uint8Array>) => parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p));
async function* from(parts: Uint8Array[]) { for (const p of parts) yield p; }
const events = async (parts: Array<string | Uint8Array>) => {
  const out = [];
  for await (const e of parseSse(from(bytes(parts)), new AbortController().signal)) out.push(e);
  return out;
};

describe('parseSse', () => {
  it('a data line split inside the field name, the value and the line break', async () => {
    expect(await events(['da', 'ta: hel', 'lo\n', '\n'])).toEqual([{ data: 'hello' }]);
  });

  it('CRLF, a lone CR, and a CRLF split between two chunks', async () => {
    expect(await events(['event: x\r\ndata: 1\r\n\r\n'])).toEqual([{ event: 'x', data: '1' }]);
    expect(await events(['data: a\r\r', 'data: b\r', '\n\r\n'])).toEqual([{ data: 'a' }, { data: 'b' }]);
  });

  it('comment lines are ignored, and a block of only comments is no event', async () => {
    expect(await events([': ping\n\n', ': more\ndata: a\n: inside\n\n'])).toEqual([{ data: 'a' }]);
  });

  it('several data lines make one event joined by a line break', async () => {
    expect(await events(['data: a\ndata: b\ndata:\ndata: c\n\n'])).toEqual([{ data: 'a\nb\n\nc' }]);
  });

  it('only one leading space of the value is dropped; no space is fine too', async () => {
    expect(await events(['data:x\n\ndata:  two\n\n'])).toEqual([{ data: 'x' }, { data: ' two' }]);
  });

  it('a multibyte character split across chunks (2, 3 and 4 byte forms)', async () => {
    const all = enc.encode('data: é€😀\n\n');
    for (let cut = 1; cut < all.length; cut++) {
      expect(await events([all.subarray(0, cut), all.subarray(cut)])).toEqual([{ data: 'é€😀' }]);
    }
    const one = [...all].map((b) => Uint8Array.of(b)); // every byte alone
    expect(await events(one)).toEqual([{ data: 'é€😀' }]);
  });

  it('a last event with no blank line after it, and one cut off after its last CR', async () => {
    expect(await events(['data: a\n\ndata: last'])).toEqual([{ data: 'a' }, { data: 'last' }]);
    expect(await events(['data: a\n\ndata: b\n'])).toEqual([{ data: 'a' }, { data: 'b' }]);
    expect(await events(['data: a\r'])).toEqual([{ data: 'a' }]);
    expect(await events([])).toEqual([]);
  });

  it('reads a ReadableStream as well as an async iterable', async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('data: a\n\nda')); c.enqueue(enc.encode('ta: b\n\n')); c.close(); } });
    const out = [];
    for await (const e of parseSse(body, new AbortController().signal)) out.push(e);
    expect(out).toEqual([{ data: 'a' }, { data: 'b' }]);
  });

  it('an abort ends the iteration quietly, even while a read waits (iterable and stream)', async () => {
    const ctl = new AbortController();
    async function* hang() { yield enc.encode('data: a\n\n'); await new Promise(() => {}); }
    const got: string[] = [];
    const it = parseSse(hang(), ctl.signal);
    const first = await it.next();
    got.push((first.value as { data: string }).data);
    const second = it.next();
    ctl.abort();
    expect((await second).done).toBe(true);
    expect(got).toEqual(['a']);

    const ctl2 = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('data: b\n\n')); } }); // never closes
    const out: string[] = [];
    for await (const e of parseSse(stream, ctl2.signal)) { out.push(e.data); ctl2.abort(); }
    expect(out).toEqual(['b']);
  });

  it('an abort between the events of one chunk stops there; an already aborted signal reads nothing', async () => {
    const ctl = new AbortController();
    const out: string[] = [];
    for await (const e of parseSse(from(bytes(['data: 1\n\ndata: 2\n\ndata: 3\n\n'])), ctl.signal)) { out.push(e.data); ctl.abort(); }
    expect(out).toEqual(['1']);
    expect(await events([])).toEqual([]);
    const done = new AbortController();
    done.abort();
    const none = [];
    for await (const e of parseSse(from(bytes(['data: x\n\n'])), done.signal)) none.push(e);
    expect(none).toEqual([]);
  });

  it('a read error that is not an abort is thrown', async () => {
    async function* bad() { yield enc.encode('data: a\n\n'); throw new Error('socket closed'); }
    const out: string[] = [];
    await expect((async () => { for await (const e of parseSse(bad(), new AbortController().signal)) out.push(e.data); })()).rejects.toThrow('socket closed');
    expect(out).toEqual(['a']);
  });
});

describe('parseSse limits and cleanup', () => {
  const MIB = 1024 * 1024;
  const LIMIT = 32 * MIB; // a line, and the data of an event
  const read = async (parts: string[]) => {
    const out: string[] = [];
    for await (const e of parseSse(from(bytes(parts)), new AbortController().signal)) out.push(e.data);
    return out;
  };
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  it('a completed line of exactly 32 MiB is fine; one character more ends the stream with an error', async () => {
    expect((await read([`data: ${'x'.repeat(LIMIT - 6)}\n\n`]))[0]).toHaveLength(LIMIT - 6);
    await expect(read([`data: ${'x'.repeat(LIMIT - 5)}\n\n`])).rejects.toThrow('too long');
  });

  it('a long line is refused whether or not its line break has arrived, and in a tail with no line break', async () => {
    await expect(read(['data: ', 'x'.repeat(LIMIT), '\n\n'])).rejects.toThrow('too long');
    await expect(read([`data: ${'x'.repeat(LIMIT)}`])).rejects.toThrow('too long');
  });

  it('a valid 1.5 MiB tool argument line is not refused', async () => {
    expect((await read([`data: ${'x'.repeat(Math.floor(1.5 * MIB))}\n\n`]))[0]).toHaveLength(Math.floor(1.5 * MIB));
  });

  it('an event may hold 32 MiB over many lines, each charged its length and one for the separator; one more is an error', async () => {
    const line = (n: number) => `data: ${'x'.repeat(n)}\n`;
    const ok = await read([line(4 * MIB - 1).repeat(8), '\n']);
    expect(ok[0]).toHaveLength(8 * (4 * MIB - 1) + 7);
    await expect(read([line(4 * MIB).repeat(8), '\n'])).rejects.toThrow('too long'); // 8 x (4 MiB + 1) is over
  });

  it('repeated empty data lines stop at 100000 lines', async () => {
    expect((await read(['data:\n'.repeat(100_000), '\n']))[0]).toHaveLength(99_999); // 100000 empty values joined by 99999 breaks
    await expect(read(['data:\n'.repeat(100_001), '\n'])).rejects.toThrow('too long');
  });

  it('the size of an event starts again after each blank line', async () => {
    const line = `data: ${'x'.repeat(4 * MIB)}\n`;
    expect(await read([`${line.repeat(7)}\n`.repeat(3)])).toHaveLength(3);
  });

  it('after an abort the body is cancelled and its reader is let go', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('data: a\n\n')); }, cancel() { cancelled = true; } });
    const ctl = new AbortController();
    for await (const e of parseSse(stream, ctl.signal)) { void e; ctl.abort(); }
    await tick();
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });

  it('an already aborted signal still cancels the body it was given', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('data: a\n\n')); }, cancel() { cancelled = true; } });
    const ctl = new AbortController();
    ctl.abort();
    for await (const e of parseSse(stream, ctl.signal)) throw new Error(`unexpected ${e.data}`);
    await tick();
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);

    let returned = false;
    const it = { [Symbol.asyncIterator]() { return { next: async () => ({ done: false as const, value: enc.encode('data: a\n\n') }), return: async () => { returned = true; return { done: true as const, value: undefined }; } }; } };
    for await (const e of parseSse(it, ctl.signal)) throw new Error(`unexpected ${e.data}`);
    await tick();
    expect(returned).toBe(true);
  });

  it('a cancel or return() that rejects is caught: no unhandled rejection, whether the stream was aborted, finished or never started', async () => {
    const seen: unknown[] = [];
    const on = (r: unknown) => { seen.push(r); };
    process.on('unhandledRejection', on);
    try {
      const mkStream = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('data: a\n\n')); }, cancel() { return Promise.reject(new Error('cancel failed')); } });
      const ctl = new AbortController();
      for await (const e of parseSse(mkStream(), ctl.signal)) { void e; ctl.abort(); }
      const done = new AbortController();
      done.abort();
      for await (const e of parseSse(mkStream(), done.signal)) throw new Error(`unexpected ${e.data}`);
      const bad = (value: Uint8Array[]) => ({ [Symbol.asyncIterator]() { let i = 0; return { next: async () => (i < value.length ? { done: false as const, value: value[i++] } : { done: true as const, value: undefined }), return: () => Promise.reject(new Error('return failed')) }; } });
      for await (const e of parseSse(bad([enc.encode('data: b\n\n')]), new AbortController().signal)) void e;
      for await (const e of parseSse(bad([]), done.signal)) throw new Error(`unexpected ${e.data}`);
      await tick(80);
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', on);
    }
  });

  it('an already aborted signal returns at once even when the cancel never settles', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('data: a\n\n')); }, cancel() { return new Promise(() => {}); } });
    const ctl = new AbortController();
    ctl.abort();
    const finished = (async () => { for await (const e of parseSse(stream, ctl.signal)) throw new Error(`unexpected ${e.data}`); return 'done'; })();
    expect(await Promise.race([finished, new Promise((r) => setTimeout(() => r('hung'), 1000))])).toBe('done');
  });
});
describe('parseSse: a cancel that never settles still lets go of the stream', () => {
  const mk = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('data: a\n\n')); }, cancel() { return new Promise(() => {}); } });

  it('mid-stream, after an abort', async () => {
    const stream = mk();
    const ctl = new AbortController();
    for await (const e of parseSse(stream, ctl.signal)) { void e; ctl.abort(); }
    await new Promise((r) => setTimeout(r, 30));
    expect(stream.locked).toBe(false);
  });

  it('when the signal was already aborted, at once', async () => {
    const stream = mk();
    const ctl = new AbortController();
    ctl.abort();
    for await (const e of parseSse(stream, ctl.signal)) throw new Error(`unexpected ${e.data}`);
    expect(stream.locked).toBe(false);
  });

  it('and a cancel that rejects, or throws at once, is not an unhandled rejection', async () => {
    const seen: unknown[] = [];
    const on = (r: unknown) => { seen.push(r); };
    process.on('unhandledRejection', on);
    try {
      const rejecting = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('data: a\n\n')); }, cancel() { return Promise.reject(new Error('no')); } });
      const ctl = new AbortController();
      ctl.abort();
      for await (const e of parseSse(rejecting, ctl.signal)) throw new Error(`unexpected ${e.data}`);
      await new Promise((r) => setTimeout(r, 60));
      expect(seen).toEqual([]);
      expect(rejecting.locked).toBe(false);
    } finally {
      process.off('unhandledRejection', on);
    }
  });
});