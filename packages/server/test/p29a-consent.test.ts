// Milestone P, Task 29 phase A4: a yes is for the origin the user was shown (the challenge returns it, the grant requires it back), a revocation that
// lands while a send waits for its consent is seen at the last step before the request, and the question says what the yes covers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setConsent, testConnection, type ModEnv } from '../src/mods/actions.js';
import { startMods } from '../src/engines.js';
import type { Mods } from '../src/mods/types.js';
import { ConsentNeeded, makeSend } from '../src/send.js';

const KEY = 'sk-test-0123456789abcdef';
let tmp = '';
let home = '';
let mods: Mods;
beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p29a-consent-')));
  home = path.join(tmp, '.reins');
  const dir = path.join(home, 'mods', 'kp');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({
    reins: 1, id: 'kp', kind: 'provider', version: '1.0.0', label: 'Kp', protocol: 'openai-chat', baseUrl: 'https://a.example.invalid/v1',
    defaultModel: 'm', models: [{ id: 'm' }], auth: { style: 'bearer', keyEnv: ['KP_API_KEY'] },
  }));
  mods = await startMods({ dir: home, env: {} });
});
afterEach(() => {
  mods.dispose();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const granted: string[] = [];
const env = (): ModEnv => ({
  home, catalogDir: path.join(tmp, 'none'), mods, consent: { has: () => false, grant: (id, origin) => { granted.push(`${id} ${origin}`); }, revoke: () => {} },
  send: async () => new Response(''), env: { KP_API_KEY: KEY }, redact: (t) => t, holdsSecret: () => false,
});
beforeEach(() => { granted.length = 0; });

describe('A4a: the grant is for the origin that was shown', () => {
  it('the Test connection challenge returns the canonical origin it asked about', async () => {
    const r = await testConnection(env(), 'kp');
    expect(r.body).toMatchObject({ result: 'needs-consent', host: 'a.example.invalid', origin: 'https://a.example.invalid' });
  });

  it('a grant with no origin is refused with 409 and records nothing', async () => {
    const r = await setConsent(env(), 'kp', {});
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/address/);
    expect(granted).toEqual([]);
  });

  it('a grant for another origin is refused with 409 and records nothing', async () => {
    const r = await setConsent(env(), 'kp', { origin: 'https://b.example.invalid' });
    expect(r.status).toBe(409);
    expect(granted).toEqual([]);
  });

  it('a grant for the shown origin is recorded', async () => {
    const r = await setConsent(env(), 'kp', { origin: 'https://a.example.invalid' });
    expect(r.status).toBe(200);
    expect(granted).toEqual(['kp https://a.example.invalid']);
  });

  it('revoking needs no origin', async () => {
    expect((await setConsent(env(), 'kp', { revoke: true })).status).toBe(200);
  });
});

describe('A4b: consent is checked in the same synchronous step as the request', () => {
  const p = { id: 'neutral', kind: 'provider', label: 'Neutral', baseUrl: 'https://example.invalid', auth: { style: 'none', keyEnv: [] } };
  const plain = { redact: (s: string) => s, has: () => false, safeLength: (s: string) => s.length };

  it('with a synchronous answer no other task runs between the check and the request (Codex reproducer: consent was false at fetch)', async () => {
    let allowed = true;
    let consentAtFetch: boolean | undefined;
    const send = makeSend({
      secrets: () => new Map(), env: {}, current: () => p as never, redactor: plain,
      consent: () => { queueMicrotask(() => { allowed = false; }); return allowed; }, // a revocation queued the moment consent is read
      fetch: async () => { consentAtFetch = allowed; return new Response('{}'); },
    });
    await send(p as never, `${p.baseUrl}/chat`, { method: 'POST', body: 'fake prompt' });
    expect(consentAtFetch).toBe(true);
  });

  it('with an answer that is a promise, the consent is asked again after the wait, and a revocation that landed during it stops the request', async () => {
    let asks = 0;
    let fetched = 0;
    const send = makeSend({
      secrets: () => new Map(), env: {}, current: () => p as never, redactor: plain,
      consent: () => (++asks === 1 ? Promise.resolve(true) : false), consentNow: () => false, // yes while waiting, revoked by the time it is looked at again
      fetch: async () => { fetched++; return new Response('{}'); },
    });
    const err = await send(p as never, `${p.baseUrl}/chat`, { method: 'POST', body: 'fake prompt' }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ConsentNeeded);
    expect(fetched).toBe(0);
  });

  it('a consent that stays granted still sends', async () => {
    let fetched = 0;
    const send = makeSend({
      secrets: () => new Map(), env: {}, current: () => p as never, redactor: plain,
      consent: () => true,
      fetch: async () => { fetched++; return new Response('{}'); },
    });
    await send(p as never, `${p.baseUrl}/chat`, { method: 'POST', body: 'fake prompt' });
    expect(fetched).toBe(1);
  });
});
