// Server-sent events: framing across any chunk boundary. `[DONE]` and JSON are the wire's business.

export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Longest single line and most `data:` text of one event, in characters (a 4 MiB tool argument can grow about six-fold in JSON escapes), and
 * most stored data lines of one event. Each stored line is charged its length plus one for the separator. Over any, the stream ends with an error.
 */
const MAX_LINE = 32 * 1024 * 1024;
const MAX_EVENT = 32 * 1024 * 1024;
const MAX_LINES = 100_000;

/** One reading end for both kinds of body. `close` cancels the body and lets go of it; it never rejects, and callers need not wait for it. */
function open(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>) {
  if ('getReader' in body) {
    const r = body.getReader();
    return {
      next: () => r.read() as Promise<IteratorResult<Uint8Array>>,
      close: () => {
        // Cancel is requested now, its promise is handled on its own (it may reject or never settle), and the lock is let go at once.
        let done: Promise<void>;
        try {
          done = r.cancel().then(() => {}, () => {});
        } catch {
          done = Promise.resolve();
        }
        try {
          r.releaseLock();
        } catch {
          /* already released */
        }
        return done;
      },
    };
  }
  const it = body[Symbol.asyncIterator]();
  return { next: () => it.next(), close: () => Promise.resolve().then(() => it.return?.()).then(() => {}, () => {}) };
}

/**
 * Events of an SSE body. Handles CRLF, CR and LF, comment lines, multi-line `data:`, a multibyte character split across chunks,
 * and a last event with no blank line after it. An abort ends the iteration quietly, even while a read is waiting; any other
 * read error is thrown. A line over MAX_LINE or an event over MAX_EVENT is an error.
 */
export async function* parseSse(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, signal: AbortSignal, onChunk?: () => void): AsyncGenerator<SseEvent> {
  if (signal.aborted) {
    // The body was handed over: cancel it, but do not wait (a cancel that never settles must not hold the caller).
    try {
      void open(body).close();
    } catch {
      /* a body that cannot be opened (locked) has nothing to cancel here */
    }
    return;
  }
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let event: string | undefined;
  let data: string[] = [];
  let eventSize = 0;
  const tooLong = () => new Error('The reply is not a valid event stream: a line or an event is too long.');

  const dispatch = (): SseEvent | undefined => {
    const out = data.length ? { ...(event !== undefined ? { event } : {}), data: data.join('\n') } : undefined;
    event = undefined;
    data = [];
    eventSize = 0;
    return out;
  };
  // One line of the stream; an event when it was the blank line that ends one.
  const line = (l: string): SseEvent | undefined => {
    if (l.length > MAX_LINE) throw tooLong();
    if (l === '') return dispatch();
    if (l.startsWith(':')) return undefined;
    const colon = l.indexOf(':');
    const field = colon < 0 ? l : l.slice(0, colon);
    let value = colon < 0 ? '' : l.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      eventSize += value.length + 1;
      if (eventSize > MAX_EVENT || data.length >= MAX_LINES) throw tooLong();
      data.push(value);
    } else if (field === 'event') event = value;
    return undefined; // id and retry are not used
  };

  const src = open(body);
  let onAbort!: () => void;
  const stopped = new Promise<'abort'>((resolve) => {
    onAbort = () => resolve('abort');
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    for (;;) {
      const pending = src.next();
      pending.catch(() => {}); // if the abort wins the race, a late failure of this read is nobody's news
      const r = await Promise.race([pending, stopped]);
      if (r === 'abort' || signal.aborted) return;
      if (r.done) break;
      onChunk?.(); // a comment or a ping is a byte too
      buf += decoder.decode(r.value, { stream: true });
      let at = 0;
      const eol = /\r\n|\n|\r/g;
      for (;;) {
        eol.lastIndex = at;
        const m = eol.exec(buf);
        // A CR at the very end may be the first half of a CRLF: wait for the next chunk.
        if (!m || (m[0] === '\r' && m.index + 1 === buf.length)) break;
        const e = line(buf.slice(at, m.index));
        at = m.index + m[0].length;
        if (e) {
          yield e;
          if (signal.aborted) return;
        }
      }
      buf = buf.slice(at);
      if (buf.length > MAX_LINE) throw tooLong();
    }
  } catch (e) {
    if (signal.aborted) return;
    throw e;
  } finally {
    signal.removeEventListener('abort', onAbort);
    void src.close(); // not awaited: a read that never ends must not hold this up
  }
  buf += decoder.decode();
  // What is left holds no line break, except a CR that waited for a LF which never came.
  const tail = buf !== '' ? line(buf.replace(/\r$/, '')) : undefined;
  if (tail) yield tail;
  const last = dispatch();
  if (last) yield last;
}
