// Milestone P, Task 29 phase A: one Redactor per process (A7), send's own refusals are not network failures (A8), and the small items of A11.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostSend, startMods } from '../src/engines.js';
import { classify } from '../src/loop/retry.js';
import type { Mods, ProviderManifest, SendWithKey } from '../src/mods/types.js';
import { HELD_MARKER, Redactor, StreamRedactor, setKey } from '../src/secrets.js';
import { isSendRefusal, makeSend } from '../src/send.js';
import { KEY, rig, type Rig } from './loop-harness.js';

const rigs: Rig[] = [];
const make = async (...a: Parameters<typeof rig>) => {
  const r = await rig(...a);
  rigs.push(r);
  return r;
};
const dirs: string[] = [];
let mods: Mods | undefined;
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
  mods?.dispose();
  mods = undefined;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('A7: one Redactor per process', () => {
  it('a key that was replaced stays masked in an engine host opened after the replacement', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p29a-misc-')));
    dirs.push(root);
    const home = path.join(root, '.reins');
    const OLD = 'sk-old-0123456789abcdef';
    const NEW = 'sk-new-0123456789abcdef';
    mods = await startMods({ dir: home, env: {} });
    setKey(home, 'p', OLD);
    const process_ = new Redactor({ home, env: {}, keyEnvNames: () => [] }); // the process's one, made at the start
    setKey(home, 'p', NEW);
    process_.refresh(); // the key was replaced: OLD is retired in it
    const host = hostSend(mods, { env: {}, home }, undefined, process_); // an engine opened after the replacement
    expect(host.redactAll!(`seen ${OLD} and ${NEW}`)).toBe('seen [key Reins] and [key Reins]');
    expect(host.holdsSecret!(OLD)).toBe(true);
    const out = host.redactStream!();
    expect(out.push(`line ${OLD}\n`)).toBe('line [key Reins]\n');
  });
});

describe('A8: what send refuses itself is not a network failure', () => {
  const plain = { redact: (t: string) => t, has: () => false, safeLength: (t: string) => t.length };
  const sendOf = (o: Partial<Parameters<typeof makeSend>[0]> = {}): SendWithKey =>
    makeSend({ secrets: () => new Map([['p', KEY]]), env: {}, redactor: plain, consent: () => true, ...o });
  const cases: Array<[string, () => SendWithKey, RegExp]> = [
    ['no key', () => sendOf({ secrets: () => new Map() }), /^No key for Fake\./],
    ['an address that holds a saved key', () => sendOf({ redactor: { ...plain, has: (t: string) => t.includes('/chat/completions') } }), /^The request address holds a saved key, so nothing was sent\.$/],
    ['too many keys', () => sendOf({ redactor: { ...plain, hold: () => undefined } }), /^Too many keys are in use/],
    ['an address that is not the provider\'s origin', () => { const real = sendOf(); return (m, _u, i, p) => real(m, 'https://other.invalid/x', i, p); }, /^Reins sends `p` requests only to /],
  ];

  it.each(cases)('%s is classified as its own refusal', async (_name, build, words) => {
    const r = await make('openai-chat');
    const err = await build()(r.p as ProviderManifest, `${r.p.baseUrl}/chat/completions`, { method: 'POST', body: '{}' }).then(() => undefined, (e: unknown) => e);
    expect(isSendRefusal(err)).toBe(true);
    expect(Object.getPrototypeOf(err)).toBe(Error.prototype); // still a plain Error
    expect(classify(err)).toBe('refused');
    expect((err as Error).message).toMatch(words);
  });

  it.each(cases)('%s ends the turn at once with its own words: no retry, no "Cannot reach"', async (_name, build, words) => {
    const r = await make('openai-chat', { host: { send: build() } });
    const s = await r.open();
    const err = await s.turn('hi').then(() => undefined, (e: unknown) => e as Error);
    expect(err).toBeDefined();
    expect(err!.message).toMatch(words);
    expect(err!.message).not.toMatch(/Cannot reach/);
    expect(r.slept).toEqual([]);
    expect(r.fake.requests).toHaveLength(0);
  });
});

describe('A11: small things', () => {
  const key = new Redactor({ home: os.tmpdir(), env: { K_API_KEY: KEY }, keyEnvNames: () => ['K_API_KEY'] });

  it('a stream that ends on the start of a key does not write that start as plain text', () => {
    const s = new StreamRedactor(key);
    const first = s.push(`out ${KEY.slice(0, 12)}`);
    expect(first).toBe('out ');
    const end = s.end();
    expect(end).not.toContain(KEY.slice(0, 6));
    expect(end).toBe(HELD_MARKER);
  });

  it('a line that ends with a newline is written whole (fix round: a one-letter key start at the very end is now hidden too, see p29a2-display)', () => {
    const s = new StreamRedactor(key);
    expect(s.push('all tests\n') + s.end()).toBe('all tests\n');
  });

  it('the card marker of a session is the same after the session is opened again', async () => {
    const r = await make('openai-chat');
    const markerOf = async (sessionId?: string) => {
      const s = await r.open(sessionId ? { sessionId } : {});
      r.push({ text: 'ok' });
      await s.turn('hi');
      await s.close();
      const body = r.fake.requests.at(-1)!.body as { messages: Array<{ role: string; content: unknown }> };
      return { id: s.sessionId, marker: /REINS CARD ([0-9a-f]+)/.exec(JSON.stringify(body.messages))?.[1] };
    };
    const first = await markerOf();
    expect(first.marker).toMatch(/^[0-9a-f]{16,}$/);
    expect((await markerOf(first.id)).marker).toBe(first.marker);
  });
});
