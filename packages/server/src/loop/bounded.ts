/**
 * The text of a response body, at most `limit` bytes of it. When the body is longer the rest is not read: the download is
 * cancelled and `over` is true. A multibyte character cut by the limit becomes a replacement character.
 */
export async function readBounded(res: Pick<Response, 'body'>, limit: number): Promise<{ text: string; over: boolean }> {
  if (!res.body) return { text: '', over: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let size = 0;
  let over = false;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.byteLength;
      if (size > limit) {
        // Streaming decode and no flush after it: a character the limit cut in two is dropped whole, not turned into U+FFFD, so the text
        // ends on a real character and a prefix-of-a-secret guard on its end sees what is really there.
        text += decoder.decode(r.value.subarray(0, r.value.byteLength - (size - limit)), { stream: true });
        over = true;
        break;
      }
      text += decoder.decode(r.value, { stream: true });
    }
    if (!over) text += decoder.decode();
  } finally {
    // Cancel is requested and its promise handled on its own (it may reject or never settle); the lock is let go at once.
    try {
      reader.cancel().catch(() => {});
    } catch {
      /* nothing to cancel */
    }
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  return { text, over };
}
