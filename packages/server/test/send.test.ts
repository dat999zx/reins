import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderManifest } from '../src/mods/types.js';
import { readBounded } from '../src/loop/bounded.js';
import { Redactor, setKey } from '../src/secrets.js';
import { ConsentNeeded, makeSend, ProviderError } from '../src/send.js';
import { startFakeProvider } from './fake-provider.js';
import { tempHome } from './mods-harness.js';

const KEY = 'sk-test-0123456789abcdef';

type Fake = Awaited<ReturnType<typeof startFakeProvider>>;
let home: ReturnType<typeof tempHome>;
let a: Fake; // the provider's own address
let b: Fake; // another address

beforeEach(async () => {
  home = tempHome();
  a = await startFakeProvider();
  b = await startFakeProvider();
  setKey(home.home, 'p', KEY);
});
afterEach(async () => {
  await a.close();
  await b.close();
  home.cleanup();
});

const manifest = (over: Partial<ProviderManifest> = {}): ProviderManifest => ({
  reins: 1, id: 'p', kind: 'provider', version: '1', label: 'Fake', protocol: 'openai-chat', baseUrl: `${a.url}/v1`,
  auth: { style: 'bearer', keyEnv: ['P_API_KEY'] }, defaultModel: 'm', models: [{ id: 'm' }], ...over,
});

function sender(o: { consent?: (id: string, origin: string) => boolean | Promise<boolean>; secrets?: Map<string, string>; fetch?: typeof fetch; env?: NodeJS.ProcessEnv; redactor?: Parameters<typeof makeSend>[0]['redactor'] } = {}) {
  const asked: Array<[string, string]> = [];
  const send = makeSend({
    secrets: () => o.secrets ?? new Map([['p', KEY]]),
    env: o.env ?? {},
    redactor: o.redactor ?? new Redactor({ home: home.home, env: o.env ?? {}, keyEnvNames: () => ['P_API_KEY', 'Q_API_KEY'] }),
    consent: (id, origin) => { asked.push([id, origin]); return (o.consent ?? (() => true))(id, origin); },
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return { send, asked };
}

const post = (url: string, init: RequestInit = {}): RequestInit & { method: string } => ({ method: 'POST', body: '{}', ...init });
const chat = () => `${a.url}/v1/chat/completions`;
const caught = async (p: Promise<unknown>) => p.then(() => { throw new Error('it did not fail'); }, (e: unknown) => e as Error);

describe('sendWithKey: origin (1)', () => {
  it('refuses another origin and sends nothing, to either server', async () => {
    const { send, asked } = sender();
    const e = await caught(send(manifest(), `${b.url}/v1/chat/completions`, post(b.url)));
    expect(e.message).toMatch(/only to .*refused.*Nothing was sent/);
    expect(a.requests).toEqual([]);
    expect(b.requests).toEqual([]);
    expect(asked).toEqual([]); // the origin is checked before the consent question
  });

  // A stub fetch that records, so no address in this table is ever contacted.
  const stub = () => {
    const urls: string[] = [];
    const fetchStub = (async (u: string) => { urls.push(String(u)); return new Response('ok'); }) as unknown as typeof fetch;
    return { urls, fetchStub };
  };

  const REFUSED: Array<[string, string]> = [
    ['userinfo naming the right host in front of another', 'https://api.example.com@evil.test/v1/x'],
    ['userinfo with a port', 'https://api.example.com:443@evil.test/v1/x'],
    ['a backslash before the real host', 'https://evil.test\\@api.example.com/v1/x'],
    ['userinfo on the right host', 'https://user@api.example.com/v1/x'],
    ['user and password on the right host', 'https://user:pw@api.example.com/v1/x'],
    ['a password with no user name', 'https://:pw@api.example.com/v1/x'],
    ['http for https', 'http://api.example.com/v1/x'],
    ['another port', 'https://api.example.com:8443/v1/x'],
    ['a longer host', 'https://api.example.com.evil.test/v1/x'],
    ['a trailing dot', 'https://api.example.com./v1/x'],
    ['a look-alike letter (IDN)', 'https://apí.example.com/v1/x'],
    ['a protocol-relative address', '//api.example.com/v1/x'],
    ['a path only', '/v1/x'],
    ['no scheme', 'api.example.com/v1/x'],
    ['an empty address', ''],
    ['a file address', 'file:///etc/passwd'],
    ['an ftp address', 'ftp://api.example.com/x'],
    ['a data address', 'data:text/plain,hello'],
    ['an ipv6 address', 'https://[::1]/v1/x'],
  ];
  it.each(REFUSED)('refuses %s', async (_name, url) => {
    const { urls, fetchStub } = stub();
    const { send, asked } = sender({ fetch: fetchStub });
    await caught(send(manifest({ baseUrl: 'https://api.example.com/v1' }), url, post(url)));
    expect(urls).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('accepts the same origin however it is spelled, and sends the normal form', async () => {
    const { urls, fetchStub } = stub();
    const { send } = sender({ fetch: fetchStub });
    const m = manifest({ baseUrl: 'https://api.example.com/v1' });
    await send(m, 'HTTPS://API.EXAMPLE.COM/v1/x', post(''));
    await send(m, 'https://api.example.com:443/v1/y', post(''));
    expect(urls).toEqual(['https://api.example.com/v1/x', 'https://api.example.com/v1/y']);
  });

  it('IDN and ipv6 spellings compare by parsed origin', async () => {
    const { urls, fetchStub } = stub();
    const { send } = sender({ fetch: fetchStub });
    const idn = manifest({ baseUrl: 'https://bücher.example/v1' });
    await send(idn, 'https://xn--bcher-kva.example/v1/x', post(''));
    await send(idn, 'https://BÜCHER.example/v1/y', post(''));
    const v6 = manifest({ baseUrl: 'http://[::1]:8080/v1' });
    await send(v6, 'http://[0:0:0:0:0:0:0:1]:8080/v1/x', post(''));
    await caught(send(v6, 'http://[::2]:8080/v1/x', post('')));
    expect(urls).toHaveLength(3);
  });

  it('refuses a base address that is not http or https, or not an address', async () => {
    const { urls, fetchStub } = stub();
    const { send } = sender({ fetch: fetchStub });
    await caught(send(manifest({ baseUrl: 'file:///tmp/x' }), 'file:///tmp/x', post('')));
    await caught(send(manifest({ baseUrl: 'nonsense' }), 'https://api.example.com/x', post('')));
    expect(urls).toEqual([]);
  });
});

describe('sendWithKey: consent (2)', () => {
  it('without consent it throws ConsentNeeded and sends nothing (a plain false, and a promise of false)', async () => {
    for (const consent of [() => false, async () => false]) {
      const { send, asked } = sender({ consent });
      const e = await caught(send(manifest(), chat(), post(chat())));
      expect(e).toBeInstanceOf(ConsentNeeded);
      expect(e).toMatchObject({ modId: 'p', origin: a.url });
      expect(asked).toEqual([['p', a.url]]);
    }
    expect(a.requests).toEqual([]);
  });

  it('with consent the request carries the key', async () => {
    a.push({ text: 'hi' });
    const { send, asked } = sender();
    const res = await send(manifest(), chat(), post(chat()));
    expect(res.status).toBe(200);
    expect(asked).toEqual([['p', a.url]]);
    expect(a.requests).toHaveLength(1);
    expect(a.requests[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('a consent that is not exactly true does not count', async () => {
    const { send } = sender({ consent: (() => 'yes') as unknown as () => boolean });
    expect(await caught(send(manifest(), chat(), post(chat())))).toBeInstanceOf(ConsentNeeded);
    expect(a.requests).toEqual([]);
  });

  it('a keyless provider is asked for chat, and is not asked for the model list', async () => {
    const m = manifest({ auth: { style: 'none', keyEnv: [] } });
    const { send, asked } = sender({ consent: () => false });
    expect(await caught(send(m, chat(), post(chat())))).toBeInstanceOf(ConsentNeeded);
    expect(await caught(send(m, chat(), post(chat()), 'chat'))).toBeInstanceOf(ConsentNeeded);
    expect(a.requests).toEqual([]);
    expect(asked).toHaveLength(2);

    const res = await send(m, `${a.url}/v1/models`, { method: 'GET' }, 'models');
    expect(res.status).toBe(200);
    expect(asked).toHaveLength(2); // no third question
    expect(a.requests[0].headers.authorization).toBeUndefined();
    // a provider with no auth block at all is keyless too
    const bare = manifest();
    delete bare.auth;
    await send(bare, `${a.url}/v1/models`, { method: 'GET' }, 'models');
    expect(asked).toHaveLength(2);
  });

  it('a provider with a key is asked for the model list as well, whatever its auth style', async () => {
    const { send, asked } = sender({ consent: () => false });
    expect(await caught(send(manifest(), `${a.url}/v1/models`, { method: 'GET' }, 'models'))).toBeInstanceOf(ConsentNeeded);
    const named = manifest({ auth: { style: 'header', header: 'X-Api-Key', keyEnv: ['P_API_KEY'] } });
    expect(await caught(send(named, `${a.url}/v1/models`, { method: 'GET' }, 'models'))).toBeInstanceOf(ConsentNeeded);
    expect(asked).toHaveLength(2);
    expect(a.requests).toEqual([]);
  });

  it('the models exception is a keyless GET with no body: anything else asks, as chat does', async () => {
    const m = manifest({ auth: { style: 'none', keyEnv: [] } });
    const { send, asked } = sender({ consent: () => false });
    expect(await caught(send(m, `${a.url}/v1/chat/completions`, { method: 'POST', body: '{"private":"prompt"}' }, 'models'))).toBeInstanceOf(ConsentNeeded);
    expect(await caught(send(m, `${a.url}/v1/models`, { method: 'GET', body: 'x' }, 'models'))).toBeInstanceOf(ConsentNeeded);
    expect(await caught(send(m, `${a.url}/v1/models`, { method: 'POST' }, 'models'))).toBeInstanceOf(ConsentNeeded);
    expect(asked).toHaveLength(3);
    expect(a.requests).toEqual([]);
    await send(m, `${a.url}/v1/models`, undefined as unknown as RequestInit, 'models'); // no init at all is a plain GET
    await send(m, `${a.url}/v1/models`, { method: 'get' }, 'models');
    expect(asked).toHaveLength(3);
    expect(a.requests).toHaveLength(2);
  });

  it('the key is not read before consent says yes', async () => {
    let reads = 0;
    let release!: (v: boolean) => void;
    const gate = new Promise<boolean>((r) => { release = r; });
    const send = makeSend({
      secrets: () => { reads++; return new Map([['p', KEY]]); }, env: {},
      redactor: new Redactor({ home: home.home, env: {}, keyEnvNames: () => ['P_API_KEY'] }), consent: () => gate,
    });
    a.push({ text: 'x' });
    const pending = send(manifest(), chat(), post(chat()));
    await new Promise((r) => setTimeout(r, 30));
    expect(reads).toBe(0);
    release(true);
    await pending;
    expect(reads).toBe(1);
  });
});

describe('sendWithKey: the auth header (3)', () => {
  it('bearer, a named header, and none', async () => {
    const { send } = sender();
    a.push({ text: '1' }, { text: '2' }, { text: '3' });
    await send(manifest(), chat(), post(chat()));
    await send(manifest({ auth: { style: 'header', header: 'X-Api-Key', keyEnv: ['P_API_KEY'] } }), chat(), post(chat()));
    await send(manifest({ auth: { style: 'none', keyEnv: [] } }), chat(), post(chat()));
    const [bearer, named, none] = a.requests.map((r) => r.headers);
    expect(bearer.authorization).toBe(`Bearer ${KEY}`);
    expect(bearer['x-api-key']).toBeUndefined();
    expect(named['x-api-key']).toBe(KEY);
    expect(named.authorization).toBeUndefined();
    expect(none.authorization).toBeUndefined();
    expect(none['x-api-key']).toBeUndefined();
  });

  it('a caller-supplied header with the same name, in any case, is replaced and never forwarded', async () => {
    const { send } = sender();
    a.push({ text: '1' }, { text: '2' }, { text: '3' });
    await send(manifest(), chat(), post(chat(), { headers: { AUTHORIZATION: 'Bearer attacker-key' } }));
    await send(manifest(), chat(), post(chat(), { headers: new Headers({ authorization: 'Bearer attacker-key' }) }));
    await send(manifest({ auth: { style: 'header', header: 'X-Api-Key', keyEnv: ['P_API_KEY'] } }), chat(), post(chat(), { headers: [['x-API-key', 'attacker-key']] }));
    expect(a.requests.map((r) => r.headers.authorization ?? r.headers['x-api-key'])).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`, KEY]);
    expect(JSON.stringify(a.requests)).not.toContain('attacker');
  });

  it('manifest headers are added, and cannot replace the key header', async () => {
    const { send } = sender();
    a.push({ text: '1' });
    await send(manifest({ headers: { 'X-Title': 'Reins', authorization: 'Bearer from-manifest' } }), chat(), post(chat(), { headers: { 'x-title': 'caller', 'content-type': 'application/json' } }));
    const h = a.requests[0].headers;
    expect(h['x-title']).toBe('Reins');
    expect(h['content-type']).toBe('application/json');
    expect(h.authorization).toBe(`Bearer ${KEY}`);
  });

  it('the key is never in the URL', async () => {
    const seen: string[] = [];
    const spy = (async (u: string, init: RequestInit) => { seen.push(String(u)); return new Response('ok', { status: init ? 200 : 200 }); }) as unknown as typeof fetch;
    const { send } = sender({ fetch: spy });
    await send(manifest(), `${a.url}/v1/chat/completions?x=1`, post(''));
    await send(manifest({ auth: { style: 'header', header: 'X-Api-Key', keyEnv: ['P_API_KEY'] } }), chat(), post(''));
    expect(seen).toHaveLength(2);
    for (const u of seen) expect(decodeURIComponent(u)).not.toContain(KEY);
    expect(seen[0]).toBe(`${a.url}/v1/chat/completions?x=1`);
  });

  it('the key comes from the env when the secrets file has none, and the error names the variable when there is none', async () => {
    a.push({ text: '1' });
    const fromEnv = sender({ secrets: new Map(), env: { P_API_KEY: 'sk-from-env-0123456789' } });
    await fromEnv.send(manifest(), chat(), post(chat()));
    expect(a.requests[0].headers.authorization).toBe('Bearer sk-from-env-0123456789');

    const none = sender({ secrets: new Map() });
    const e = await caught(none.send(manifest(), chat(), post(chat())));
    expect(e.message).toBe('No key for Fake. Add it in Settings or set P_API_KEY.');
    expect(a.requests).toHaveLength(1); // nothing more was sent
  });

  it('a header setup that cannot work fails in plain words before any request', async () => {
    const { send } = sender();
    const noName = await caught(send(manifest({ auth: { style: 'header', keyEnv: ['P_API_KEY'] } }), chat(), post(chat())));
    expect(noName.message).toMatch(/names none/);
    const odd = await caught(send(manifest({ auth: { style: 'weird', keyEnv: ['P_API_KEY'] } }), chat(), post(chat())));
    expect(odd.message).toMatch(/auth style/);
    const badKey = sender({ secrets: new Map([['p', 'sk-bad-key\nwith-newline-0123']]) });
    const e = await caught(badKey.send(manifest(), chat(), post(chat())));
    expect(e.message).toMatch(/cannot be sent as a header/);
    expect(e.message).not.toContain('with-newline');
    const badHeader = await caught(send(manifest({ headers: { 'bad name': 'x' } }), chat(), post(chat())));
    expect(badHeader.message).toMatch(/header that is not valid/);
    expect(a.requests).toEqual([]);
  });
});

describe('sendWithKey: redirects (4)', () => {
  it('a 307 to another origin is an error, and the other origin sees nothing', async () => {
    a.push({ redirectTo: `${b.url}/v1/chat/completions` });
    const { send } = sender();
    const e = await caught(send(manifest(), chat(), post(chat())));
    expect(e.message).toMatch(/redirect/);
    expect(e.message).not.toContain(KEY);
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toEqual([]);
  });

  it('even a redirect to the same origin is an error, and a caller asking to follow does not change that', async () => {
    a.push({ redirectTo: `${a.url}/v1/other` });
    a.push({ redirectTo: `${b.url}/v1/chat/completions` });
    const { send } = sender();
    expect((await caught(send(manifest(), chat(), post(chat())))).message).toMatch(/redirect/);
    expect((await caught(send(manifest(), chat(), post(chat(), { redirect: 'follow' })))).message).toMatch(/redirect/);
    expect(b.requests).toEqual([]);
    expect(a.requests.map((r) => r.path)).toEqual(['/v1/chat/completions', '/v1/chat/completions']);
  });

  it('every request is made with redirect: error, whatever the caller asked', async () => {
    const seen: Array<RequestInit['redirect']> = [];
    const spy = (async (_u: string, init: RequestInit) => { seen.push(init.redirect); return new Response('ok'); }) as unknown as typeof fetch;
    const { send } = sender({ fetch: spy });
    await send(manifest(), chat(), post(chat()));
    await send(manifest(), chat(), post(chat(), { redirect: 'follow' }));
    await send(manifest(), chat(), post(chat(), { redirect: 'manual' }));
    expect(seen).toEqual(['error', 'error', 'error']);
  });
});

describe('sendWithKey: errors are redacted (5)', () => {
  it('an error status becomes an Error with the status and the redacted body', async () => {
    a.push({ status: 401, body: `{"error":{"message":"Incorrect API key provided: ${KEY}. Also ${KEY}."}}` });
    const { send } = sender();
    const e = await caught(send(manifest(), chat(), post(chat())));
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).status).toBe(401);
    expect(e.message).toContain('Fake answered 401');
    expect(e.message).toContain('[key Reins]');
    expect(e.message).not.toContain(KEY);
    expect(e.stack ?? '').not.toContain(KEY);
  });

  it('the body is cut to 2000 characters after redacting, so a key cannot be cut in half at the end', async () => {
    a.push({ status: 500, body: 'x'.repeat(1900) + KEY + 'y'.repeat(300) });
    const { send } = sender();
    const e = await caught(send(manifest(), chat(), post(chat())));
    expect(e.message.length).toBeLessThanOrEqual('Fake answered 500: '.length + 2000);
    expect(e.message).not.toContain('sk-test');
    expect(e.message).toContain('[key Reins]');
    expect(e.message.endsWith('y')).toBe(true); // it was cut
  });

  it('an empty error body still names the status', async () => {
    a.push({ status: 503, body: '' });
    const { send } = sender();
    expect((await caught(send(manifest(), chat(), post(chat())))).message).toBe('Fake answered 503.');
  });

  it('a failure thrown by fetch is redacted too, with its cause, and keeps the abort name', async () => {
    const boom = (async () => { throw new TypeError('fetch failed', { cause: new Error(`connect refused for ${KEY}`) }); }) as unknown as typeof fetch;
    const e = await caught(sender({ fetch: boom }).send(manifest(), chat(), post(chat())));
    expect(e.message).toContain('fetch failed');
    expect(e.message).not.toContain(KEY);
    expect(e.stack ?? '').not.toContain(KEY);
    expect(String((e as { cause?: unknown }).cause ?? '')).not.toContain(KEY);

    const aborted = (async () => { throw new DOMException(`stopped ${KEY}`, 'AbortError'); }) as unknown as typeof fetch;
    const e2 = await caught(sender({ fetch: aborted }).send(manifest(), chat(), post(chat())));
    expect(e2.name).toBe('AbortError');
    expect(e2.message).not.toContain(KEY);
  });

  it('a consent callback that throws is reported without the key', async () => {
    const { send } = sender({ consent: () => { throw new Error(`store failed ${KEY}`); } });
    const e = await caught(send(manifest(), chat(), post(chat())));
    expect(e.message).toBe('store failed [key Reins]');
    expect(a.requests).toEqual([]);
  });

  it('a successful reply is returned as it is', async () => {
    a.push({ text: 'hello' });
    const res = await sender().send(manifest(), chat(), post(chat()));
    expect(await res.text()).toContain('hello');
  });
});

describe('sendWithKey: the caller signal', () => {
  it('an abort reaches the request and the error says so', async () => {
    a.push({ hangMs: 5000 });
    const ctl = new AbortController();
    const pending = caught(sender().send(manifest(), chat(), post(chat(), { signal: ctl.signal })));
    setTimeout(() => ctl.abort(), 50);
    const e = await pending;
    expect(e.name).toBe('AbortError');
  });
});

describe('fix round: the transport belongs to send', () => {
  it('only method, body, signal, the rebuilt headers and redirect reach fetch', async () => {
    const seen: RequestInit[] = [];
    const spy = (async (_u: string, init: RequestInit) => { seen.push(init); return new Response('ok'); }) as unknown as typeof fetch;
    const init = {
      method: 'POST', body: '{}', signal: new AbortController().signal, headers: { a: 'b' },
      dispatcher: { x: 1 }, agent: {}, keepalive: true, cache: 'no-store', referrer: 'http://x.test', window: null,
      credentials: 'include', mode: 'no-cors', integrity: 'x', duplex: 'half', priority: 'high',
    } as unknown as RequestInit;
    await sender({ fetch: spy }).send(manifest(), chat(), init);
    expect(Object.keys(seen[0]).sort()).toEqual(['body', 'headers', 'method', 'redirect', 'signal']);
  });

  it('a dispatcher of the caller is never called, and the request goes the normal way', async () => {
    a.push({ text: 'hi' });
    let called = 0;
    const dispatcher = { dispatch() { called++; return false; } };
    const res = await sender().send(manifest(), chat(), { ...post(chat()), dispatcher, signal: AbortSignal.timeout(3000) } as unknown as RequestInit);
    expect(res.status).toBe(200);
    expect(called).toBe(0);
    expect(a.requests).toHaveLength(1);
    expect(a.requests[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });
});

describe('fix round: one snapshot', () => {
  it('mod.id changed while consent waits changes neither the consent asked nor the key used', async () => {
    const mod = manifest();
    const secrets = new Map([['p', KEY], ['victim', 'sk-victim-0123456789abcdef']]);
    const { send, asked } = sender({ secrets, consent: () => { mod.id = 'victim'; return true; } });
    a.push({ text: 'x' });
    await send(mod, chat(), post(chat()));
    expect(asked).toEqual([['p', a.url]]);
    expect(a.requests[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('a headers getter that turns a keyless manifest into a bearer one after the consent step sends no key', async () => {
    const mod = manifest({ auth: { style: 'none', keyEnv: [] } });
    let reads = 0;
    Object.defineProperty(mod, 'headers', { enumerable: true, get() { reads++; mod.auth = { style: 'bearer', keyEnv: ['P_API_KEY'] }; return {}; } });
    const { send, asked } = sender({ consent: () => false });
    await send(mod, `${a.url}/v1/models`, { method: 'GET' }, 'models');
    expect(asked).toEqual([]);
    expect(reads).toBe(1); // read once, up front
    expect(a.requests).toHaveLength(1);
    expect(a.requests[0].headers.authorization).toBeUndefined();
  });

  it('a baseUrl changed during consent never moves the request or the key to another origin', async () => {
    const mod = manifest();
    const { send } = sender({ consent: () => { mod.baseUrl = `${b.url}/v1`; return true; } });
    a.push({ text: 'x' });
    await send(mod, chat(), post(chat()));
    expect(b.requests).toEqual([]);
    expect(a.requests).toHaveLength(1);
    expect(a.requests[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('the headers of the caller are copied before consent: a change during the wait is not sent', async () => {
    const hs = new Headers({ 'x-early': '1' });
    const { send } = sender({ consent: () => { hs.set('x-late', '1'); return true; } });
    a.push({ text: 'x' });
    await send(manifest(), chat(), post(chat(), { headers: hs }));
    expect(a.requests[0].headers['x-early']).toBe('1');
    expect(a.requests[0].headers['x-late']).toBeUndefined();
  });

  it('a manifest that cannot be copied is refused in plain words, with nothing sent', async () => {
    const mod = manifest();
    (mod as unknown as { loop: unknown }).loop = mod; // a circle
    const { send, asked } = sender();
    expect((await caught(send(mod, chat(), post(chat())))).message).toBe('The provider settings could not be read.');
    expect(asked).toEqual([]);
    expect(a.requests).toEqual([]);
  });
});

describe('fix round: the key is trimmed once and checked', () => {
  const KEY2 = 'sk-env-0123456789abcdef';
  it.each(['\n', ' ', '\r\n', '\t '])('an env key ending in %j is sent trimmed, and the 401 that echoes it is redacted', async (tail) => {
    a.push({ status: 401, body: `bad key ${KEY2}` });
    const env = { P_API_KEY: `${KEY2}${tail}` };
    const e = await caught(sender({ secrets: new Map(), env }).send(manifest(), chat(), post(chat())));
    expect(a.requests[0].headers.authorization).toBe(`Bearer ${KEY2}`);
    expect(e.message).not.toContain(KEY2);
    expect(e.message).toContain('[key P_API_KEY]');
  });

  it('a secrets-file key with edge whitespace is sent trimmed too', async () => {
    a.push({ text: 'x' });
    await sender({ secrets: new Map([['p', `\n ${KEY} \n`]]) }).send(manifest(), chat(), post(chat()));
    expect(a.requests[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it.each(['sk-bad\tkey-0123456789abcd', 'sk-bad\u007fkey-0123456789abcd', 'sk-bad\u0001key-0123456789abcd'])('a key with a control character inside is refused without echoing it (%#)', async (bad) => {
    const e = await caught(sender({ secrets: new Map([['p', bad]]) }).send(manifest(), chat(), post(chat())));
    expect(e.message).toMatch(/control character/);
    expect(e.message).not.toContain('sk-bad');
    expect(e.stack ?? '').not.toContain('sk-bad');
    expect(a.requests).toEqual([]);
  });

  it('a key that is only whitespace counts as missing', async () => {
    const e = await caught(sender({ secrets: new Map([['p', ' \n ']]), env: { P_API_KEY: '  ' } }).send(manifest(), chat(), post(chat())));
    expect(e.message).toBe('No key for Fake. Add it in Settings or set P_API_KEY.');
    expect(a.requests).toEqual([]);
  });
});

describe('fix round: errors built here carry no secret', () => {
  const plain = (e: Error) => {
    expect(Object.getPrototypeOf(e)).toBe(Error.prototype);
    expect(Object.keys(e)).toEqual([]);
    expect(e.cause).toBeUndefined();
    for (const t of [e.message, e.stack ?? '', e.name]) expect(t).not.toContain(KEY);
  };

  it('a ConsentNeeded thrown by the consent callback, with a cause and a property, becomes a plain Error', async () => {
    const bad = new ConsentNeeded(KEY, KEY);
    (bad as unknown as { cause: unknown }).cause = new Error(KEY);
    (bad as unknown as { leak: string }).leak = KEY;
    const e = await caught(sender({ consent: () => { throw bad; } }).send(manifest(), chat(), post(chat())));
    expect(e).not.toBeInstanceOf(ConsentNeeded);
    plain(e);
  });

  it('a ProviderError thrown by the consent callback becomes a plain Error', async () => {
    const e = await caught(sender({ consent: () => { throw new ProviderError(KEY, 500); } }).send(manifest(), chat(), post(chat())));
    expect(e).not.toBeInstanceOf(ProviderError);
    plain(e);
  });

  it('an error with a name that carries the key is rebuilt under the plain name', async () => {
    const odd = Object.assign(new Error(`boom ${KEY}`), { name: KEY });
    const e = await caught(sender({ consent: () => { throw odd; } }).send(manifest(), chat(), post(chat())));
    plain(e);
    expect(e.name).toBe('Error');
  });

  it('the ConsentNeeded this file throws has redacted fields even for an id that is a key, and no cause', async () => {
    const e = await caught(sender({ consent: () => false }).send(manifest({ id: KEY }), chat(), post(chat())));
    expect(e).toBeInstanceOf(ConsentNeeded);
    expect((e as ConsentNeeded).modId).not.toContain(KEY);
    expect((e as ConsentNeeded).modId).toBe('[key Reins]');
    expect(Object.keys(e).sort()).toEqual(['modId', 'name', 'origin']);
    expect(e.cause).toBeUndefined();
    for (const t of [e.message, e.stack ?? '']) expect(t).not.toContain(KEY);
  });

  it('a manifest label that is a known key does not show in a ProviderError', async () => {
    a.push({ status: 500, body: 'down' });
    const e = await caught(sender().send(manifest({ label: KEY }), chat(), post(chat())));
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).status).toBe(500);
    expect(e.message).toBe('[key Reins] answered 500: down');
    expect(e.stack ?? '').not.toContain(KEY);
  });

  it('a label that is a key does not show in the missing-key error either', async () => {
    const e = await caught(sender({ secrets: new Map() }).send(manifest({ label: KEY }), chat(), post(chat())));
    expect(e.message).not.toContain(KEY);
  });
});

describe('fix round: bounds', () => {
  it('an error body is read only up to 64 KiB, then the download is cancelled', async () => {
    let pulls = 0;
    let cancelled = false;
    const chunk = new Uint8Array(16 * 1024).fill(120);
    const body = new ReadableStream<Uint8Array>({
      pull(c) { if (++pulls > 400) c.close(); else c.enqueue(chunk); },
      cancel() { cancelled = true; },
    });
    const f = (async () => new Response(body, { status: 500 })) as unknown as typeof fetch;
    const e = await caught(sender({ fetch: f }).send(manifest(), chat(), post(chat())));
    expect(pulls).toBeLessThan(10);
    expect(cancelled).toBe(true);
    expect(e.message.length).toBeLessThanOrEqual('Fake answered 500: '.length + 2000);
  });

  it('a key at the end of the read limit is not shown half way', async () => {
    const limit = 64 * 1024;
    const f = (async () => new Response('x'.repeat(limit - 10) + KEY + 'y'.repeat(100), { status: 500 })) as unknown as typeof fetch;
    const e = await caught(sender({ fetch: f }).send(manifest(), chat(), post(chat())));
    expect(e.message).not.toContain('sk-test');
  });
});

describe('fix round: a known key is not allowed in the address', () => {
  const hex = (s: string) => [...s].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
  it.each([['a query value', () => `${a.url}/v1/x?leaked=${KEY}`], ['a path part', () => `${a.url}/v1/${KEY}`], ['a percent-encoded form', () => `${a.url}/v1/${hex(KEY)}`]])('refuses %s, sends nothing and does not echo the address', async (_n, make) => {
    const url = make();
    const { send, asked } = sender();
    const e = await caught(send(manifest(), url, post(url)));
    expect(e.message).toBe('The request address holds a saved key, so nothing was sent.');
    expect(asked).toEqual([]);
    expect(a.requests).toEqual([]);
  });
});
describe('fix round 2: no half key in a cut error', () => {
  const KEY1000 = `sk-big-${'k'.repeat(993)}`;
  const PREFIX = 'sk-test-'; // any 8 characters of the key at the start would be a leak
  const body = (text: string, status = 500) => (async () => new Response(text, { status })) as unknown as typeof fetch;

  it('a 1000-character key repeated in the body and then crossing the 64 KiB read limit leaves no prefix', async () => {
    setKey(home.home, 'p', KEY1000);
    const f = body(KEY1000.repeat(66)); // 66000 characters: 65 whole keys, then the read stops inside the 66th
    const e = await caught(sender({ secrets: new Map([['p', KEY1000]]), fetch: f }).send(manifest(), chat(), post(chat())));
    expect(e.message).toContain('[key Reins]');
    expect(e.message).not.toContain(KEY1000.slice(0, 8));
    expect(e.stack ?? '').not.toContain(KEY1000.slice(0, 8));
  });

  it('a key that straddles the 2000-character cap, and one that ends exactly at it, leave no prefix', async () => {
    for (const text of ['x'.repeat(1990) + KEY + 'y'.repeat(50), 'x'.repeat(2000 - KEY.length) + KEY + 'y'.repeat(50), 'x'.repeat(1996) + KEY]) {
      const e = await caught(sender({ fetch: body(text) }).send(manifest(), chat(), post(chat())));
      expect(e.message).not.toContain(PREFIX);
      expect(e.message.length).toBeLessThanOrEqual('Fake answered 500: '.length + 2000);
    }
  });

  it('the cut never ends on the start of a known key that was in the text on its own', async () => {
    const e = await caught(sender({ fetch: body('x'.repeat(1990) + 'sk-test-01' + 'zzzz') }).send(manifest(), chat(), post(chat())));
    expect(e.message.endsWith('x')).toBe(true); // the partial key at the very end is held back, whole text or not
  });
});

describe('fix round 2: errors are owned by the call that made them', () => {
  it('a ConsentNeeded from one call, polluted with the key everywhere, thrown by a later consent callback, comes out clean', async () => {
    const first = await caught(sender({ consent: () => false }).send(manifest(), chat(), post(chat())));
    expect(first).toBeInstanceOf(ConsentNeeded);
    first.message = `leak ${KEY}`;
    first.stack = `Error: ${KEY}\n    at x`;
    (first as unknown as { cause: unknown }).cause = new Error(KEY);
    (first as unknown as { leak: string }).leak = KEY;
    (first as ConsentNeeded).modId = KEY;
    const e = await caught(sender({ consent: () => { throw first; } }).send(manifest(), chat(), post(chat())));
    expect(e).not.toBeInstanceOf(ConsentNeeded);
    expect(Object.getPrototypeOf(e)).toBe(Error.prototype);
    expect(Object.keys(e)).toEqual([]);
    expect(e.cause).toBeUndefined();
    for (const t of [e.message, e.stack ?? '', e.name]) expect(t).not.toContain(KEY);
    expect(a.requests).toEqual([]);
  });

  it('the same for a ProviderError from an earlier call', async () => {
    a.push({ status: 500, body: 'down' });
    const first = await caught(sender().send(manifest(), chat(), post(chat())));
    expect(first).toBeInstanceOf(ProviderError);
    first.message = `leak ${KEY}`;
    const e = await caught(sender({ consent: () => { throw first; } }).send(manifest(), chat(), post(chat())));
    expect(e).not.toBeInstanceOf(ProviderError);
    expect(e.message).not.toContain(KEY);
  });

  it('a key that spans the status line and the detail is caught: the message is sanitized as one string', async () => {
    const JOIN = '500: detail';
    setKey(home.home, 'p', JOIN);
    a.push({ status: 500, body: 'detail' });
    const e = await caught(sender({ secrets: new Map([['p', JOIN]]) }).send(manifest(), chat(), post(chat())));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).not.toContain(JOIN);
    expect(e.message).toBe('Fake answered [key Reins]');
  });
});

describe('fix round 2: a failing sanitizer or classifier gives a constant error', () => {
  const HIDDEN = 'The request failed and its details were hidden.';
  const boom = { redact: () => { throw new Error(KEY); }, has: () => false, safeLength: (t: string) => t.length };
  const noKey = (e: Error) => { for (const t of [e.message, e.stack ?? '', e.name]) expect(t).not.toContain(KEY); };

  it('a redact that throws Error(key): a refusal, a callback error and a fetch error all become the constant', async () => {
    for (const s of [
      sender({ redactor: boom, consent: () => false }),
      sender({ redactor: boom, consent: () => { throw new Error('x'); } }),
      sender({ redactor: boom, fetch: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch }),
      sender({ redactor: boom, fetch: (async () => new Response('down', { status: 500 })) as unknown as typeof fetch }),
    ]) {
      const e = await caught(s.send(manifest(), chat(), post(chat())));
      expect(e.message).toBe(HIDDEN);
      noKey(e);
    }
  });

  it('a hostile Proxy thrown by the consent callback, and a value whose message getter throws, become the constant', async () => {
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error(KEY); } });
    const e = await caught(sender({ consent: () => { throw hostile; } }).send(manifest(), chat(), post(chat())));
    expect(e.message).toBe(HIDDEN);
    noKey(e);
    const getter = Object.defineProperty(new Error('x'), 'message', { get() { throw new Error(KEY); } });
    const e2 = await caught(sender({ consent: () => { throw getter; } }).send(manifest(), chat(), post(chat())));
    expect(e2.message).toBe(HIDDEN);
    noKey(e2);
  });
});

describe('fix round 2: the models exception is the exact model-list address', () => {
  it('a keyless GET to anything but the model list asks consent, with or without a query', async () => {
    const m = manifest({ auth: { style: 'none', keyEnv: [] } });
    const { send, asked } = sender({ consent: () => false });
    for (const path of ['/v1/chat?prompt=private', '/v1/models?x=1', '/v1/models/extra', '/v1/model', '/other', '/v1/models#frag']) {
      expect(await caught(send(m, `${a.url}${path}`, { method: 'GET' }, 'models'))).toBeInstanceOf(ConsentNeeded);
    }
    expect(asked).toHaveLength(6);
    expect(a.requests).toEqual([]);
  });

  it('modelsUrl is the list address when the manifest has one, and then /models is not', async () => {
    const m = manifest({ auth: { style: 'none', keyEnv: [] }, modelsUrl: `${a.url}/v1/catalog` });
    const seen: string[] = [];
    const f = (async (u: string) => { seen.push(u); return new Response('[]'); }) as unknown as typeof fetch;
    const { send, asked } = sender({ consent: () => false, fetch: f });
    await send(m, `${a.url}/v1/catalog`, { method: 'GET' }, 'models');
    expect(asked).toEqual([]);
    expect(await caught(send(m, `${a.url}/v1/models`, { method: 'GET' }, 'models'))).toBeInstanceOf(ConsentNeeded);
    expect(seen).toEqual([`${a.url}/v1/catalog`]);
  });

  it('a base address with a trailing slash still has /models as its list', async () => {
    const m = manifest({ auth: { style: 'none', keyEnv: [] }, baseUrl: `${a.url}/v1/` });
    const { send, asked } = sender({ consent: () => false });
    await send(m, `${a.url}/v1/models`, { method: 'GET' }, 'models');
    expect(asked).toEqual([]);
  });
});

describe('fix round 2: a key in the address, whatever else is in it', () => {
  const hex = (s: string) => [...s].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
  const refused = async (url: string) => {
    const { send, asked } = sender();
    const e = await caught(send(manifest(), url, post(url)));
    expect(asked).toEqual([]);
    expect(a.requests).toEqual([]);
    return e.message;
  };

  it('an encoded key next to a malformed escape elsewhere is refused (not fetched)', async () => {
    expect(await refused(`${a.url}/v1/x?leaked=${hex(KEY)}&bad=%FF`)).toBe('The request address has a broken percent escape, so nothing was sent.');
  });

  it('any malformed escape is refused with a fixed message that does not echo the address', async () => {
    for (const url of [`${a.url}/v1/x?bad=%FF`, `${a.url}/v1/%zz`, `${a.url}/v1/x?q=100%`, `${a.url}/v1/x#%E0%A4%A`]) {
      expect(await refused(url)).toBe('The request address has a broken percent escape, so nothing was sent.');
    }
  });

  it('an encoded key in a path part, a query name, a query value or the fragment is refused', async () => {
    for (const url of [`${a.url}/v1/${hex(KEY)}/x`, `${a.url}/v1/x?${hex(KEY)}=1`, `${a.url}/v1/x?k=${hex(KEY)}`, `${a.url}/v1/x#${hex(KEY)}`]) {
      expect(await refused(url)).toBe('The request address holds a saved key, so nothing was sent.');
    }
  });

  it('a valid escape that is not a key goes through, with plus and spaces', async () => {
    a.push({ text: 'x' });
    const url = `${a.url}/v1/chat/completions?q=a%20b+c&r=%C3%A9`;
    await sender().send(manifest(), url, post(url));
    expect(a.requests).toHaveLength(1);
  });
});

describe('fix round 2: the body, the signal and the method are read once', () => {
  it('swapping them during the consent wait changes nothing that is sent', async () => {
    const seen: RequestInit[] = [];
    const spy = (async (_u: string, init: RequestInit) => { seen.push(init); return new Response('ok'); }) as unknown as typeof fetch;
    const first = new AbortController();
    const second = new AbortController();
    const init: RequestInit = { method: 'POST', body: 'original', signal: first.signal, headers: { 'x-a': '1' } };
    const { send } = sender({ fetch: spy, consent: () => { init.body = 'swapped'; init.signal = second.signal; init.method = 'DELETE'; init.headers = { 'x-b': '2' }; return true; } });
    await send(manifest(), chat(), init);
    expect(seen[0].body).toBe('original');
    expect(seen[0].signal).toBe(first.signal);
    expect(seen[0].method).toBe('POST');
    expect((seen[0].headers as Headers).get('x-a')).toBe('1');
    expect((seen[0].headers as Headers).get('x-b')).toBeNull();
  });
});
describe('fix round 3: a read cut inside a multibyte character leaves no key prefix', () => {
  const LIMIT = 64 * 1024;
  const bytes = (s: string) => Buffer.byteLength(s);
  // [name, key, how many whole keys fit before the limit, so the cut lands inside the next one]
  const CASES: Array<[string, string]> = [
    ['two-byte', `sk-multi-${'é'.repeat(991)}`],
    ['three-byte', `sk-tri-x${'€'.repeat(992)}`],
    ['four-byte', `sk-emo-12${'😀'.repeat(496)}`],
  ];
  it.each(CASES)('%s: the key repeated, then the 64 KiB byte limit inside a character', async (_n, key) => {
    setKey(home.home, 'p', key); // the Redactor reads the file; the request itself is sent with the plain KEY (a header cannot hold these characters)
    const text = key.repeat(80);
    expect(bytes(text)).toBeGreaterThan(LIMIT);
    const cutInside = LIMIT - bytes(key) * Math.floor(LIMIT / bytes(key)); // bytes of the last key that are read
    expect(Buffer.from(key).subarray(0, cutInside).toString().endsWith('�')).toBe(true); // the cut really is inside a character
    const f = (async () => new Response(text, { status: 500 })) as unknown as typeof fetch;
    const e = await caught(sender({ fetch: f }).send(manifest(), chat(), post(chat())));
    const prefix = key.slice(0, 8);
    expect(e.message).toContain('[key Reins]');
    expect(e.message).not.toContain(prefix);
    expect(e.stack ?? '').not.toContain(prefix);
    expect(e.message).not.toContain('�');
  });

  it('readBounded drops the cut character instead of making U+FFFD, and ends on whole characters', async () => {
    for (const ch of ['é', '€', '😀']) {
      const { text, over } = await readBounded(new Response(ch.repeat(100_000)), LIMIT);
      expect(over).toBe(true);
      expect(text).not.toContain('�');
      expect([...text].every((c) => c === ch)).toBe(true);
      expect(bytes(text)).toBeLessThanOrEqual(LIMIT);
      expect(bytes(text)).toBeGreaterThan(LIMIT - 4);
    }
  });

  it('a body that is exactly at the limit is read whole and is not over', async () => {
    const { text, over } = await readBounded(new Response('a'.repeat(LIMIT)), LIMIT);
    expect(over).toBe(false);
    expect(text).toHaveLength(LIMIT);
  });
});

describe('fix round 3: overlapping known keys in an error body', () => {
  it('both are hidden whole, with one marker for the overlap', async () => {
    a.push({ status: 500, body: 'abcdefghABCDEFGHABCDEFGH!' });
    const env = { P_API_KEY: 'abcdefghABCDEFGH', Q_API_KEY: 'ABCDEFGHABCDEFGH' };
    const e = await caught(sender({ secrets: new Map(), env }).send(manifest(), chat(), post(chat())));
    expect(e.message).toBe('Fake answered 500: [key P_API_KEY]!');
    expect(e.stack ?? '').not.toContain('ABCDEFGH');
  });
});

describe('fix round 3: the status is read once and must be a whole HTTP status', () => {
  const reply = (status: unknown) => (async () => ({ status, ok: false, body: null, headers: new Headers(), text: async () => '' })) as unknown as typeof fetch;
  const send = (f: typeof fetch) => sender({ fetch: f }).send(manifest(), chat(), post(chat()));

  it.each([[{ secret: KEY }], ['500'], [99], [600], [500.5], [Number.NaN], [null], [undefined]])('%j is refused in plain words, with nothing of it carried', async (status) => {
    const e = await caught(send(reply(status)));
    expect(e.message).toBe('Fake answered with a status Reins cannot use, so the reply was not used.');
    expect(Object.getPrototypeOf(e)).toBe(Error.prototype);
    expect('status' in e).toBe(false);
    expect(JSON.stringify(e)).not.toContain(KEY);
  });

  it('a getter is read once: a first value of 500 and then an object leaves a ProviderError with the number 500', async () => {
    let reads = 0;
    const res = { get status() { reads++; return reads === 1 ? 500 : { secret: KEY }; }, ok: false, body: null, headers: new Headers() };
    const e = await caught(send((async () => res) as unknown as typeof fetch));
    expect(reads).toBe(1);
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).status).toBe(500);
    expect(e.message).toBe('Fake answered 500.');
    expect(JSON.stringify(e)).not.toContain(KEY);
  });

  it('599 and 400 are error statuses; 204 and 304 are returned', async () => {
    for (const s of [400, 599]) expect(((await caught(send((async () => new Response('x', { status: s })) as unknown as typeof fetch))) as ProviderError).status).toBe(s);
    for (const s of [204, 304]) expect((await send((async () => new Response(null, { status: s })) as unknown as typeof fetch)).status).toBe(s);
  });
});