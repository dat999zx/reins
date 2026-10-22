import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kindOf, registerKind } from '../src/mods/kinds.js';
import { caseAlias, hashFiles, loadMods } from '../src/mods/loader.js';
import { Registry } from '../src/mods/registry.js';
import type { LoadedMod, LoadOptions } from '../src/mods/types.js';
import { tempHome } from './mods-harness.js';

let h: ReturnType<typeof tempHome>;
let bundledDir: string;
beforeEach(() => {
  h = tempHome();
  bundledDir = path.join(h.home, 'bundled');
  fs.mkdirSync(bundledDir);
});
afterEach(() => h.cleanup());

const protocol = (id: string, extra: object = {}) => ({ reins: 1, id, kind: 'protocol', version: '1.0.0', label: id, ...extra });
const provider = (id: string, extra: object = {}) => ({
  reins: 1, id, kind: 'provider', version: '1.0.0', label: id, protocol: 'openai-chat',
  baseUrl: 'https://api.acme.test/v1', auth: { style: 'bearer', keyEnv: ['ACME_API_KEY'] },
  defaultModel: 'm1', models: [{ id: 'm1' }], ...extra,
});
const writeBundled = (id: string, manifest: unknown) => {
  const dir = path.join(bundledDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify(manifest));
};
const baseProtocols = () => {
  for (const id of ['anthropic-messages', 'claude-code-cli', 'openai-chat']) writeBundled(id, protocol(id));
};
const load = (o: Partial<LoadOptions> = {}) =>
  loadMods({ bundledDir, userDir: h.modsDir, home: h.home, disabled: new Set(), trusted: () => false, env: {}, ...o });
const find = (mods: LoadedMod[], id: string) => mods.find((m) => m.id === id);

describe('1. a valid provider', () => {
  it('loads, dispose forgets it, and a mod loaded again is present', async () => {
    baseProtocols();
    h.writeMod('acme', provider('acme'));
    const a = await load();
    expect(find(a.mods, 'acme')).toMatchObject({ enabled: true, problems: [], source: 'user' });
    expect(a.registry.has('provider', 'acme')).toBe(true);
    a.dispose();
    a.dispose();
    expect(a.registry.has('provider', 'acme')).toBe(false);
    const b = await load();
    expect(b.registry.has('provider', 'acme')).toBe(true);
  });

  it('a disposer is one-shot: dispose twice, register again, the new entry stays', () => {
    const r = new Registry();
    const dispose = r.register('provider', 'acme', 1);
    dispose();
    r.register('provider', 'acme', 2);
    dispose();
    expect(r.get('provider', 'acme')).toBe(2);
    expect(() => r.register('provider', 'acme', 3)).toThrow(/already registered/);
  });

  it('ids like toString and __proto__ are plain ids', () => {
    const r = new Registry();
    expect(r.has('provider', 'toString')).toBe(false);
    expect(r.get('provider', '__proto__')).toBeUndefined();
    r.register('provider', '__proto__', 1);
    expect(r.get('provider', '__proto__')).toBe(1);
    expect(r.has('provider', 'constructor')).toBe(false);
  });
});

describe('2. the words', () => {
  const problemOf = async (folder: string, manifest: unknown, raw?: string) => {
    baseProtocols();
    const dir = h.writeMod(folder, manifest);
    if (raw !== undefined) fs.writeFileSync(path.join(dir, 'mod.json'), raw);
    const out = await load();
    return { out, mod: find(out.mods, folder) ?? out.mods.find((m) => m.problems.length), problems: out.mods.flatMap((m) => m.problems) };
  };

  it('not valid JSON', async () => {
    const { problems } = await problemOf('deepseek', {}, '{\n  "reins": 1,\n  "id": "deepseek",\n  "baseUrl": }\n');
    expect(problems).toEqual(['`~/.reins/mods/deepseek/mod.json`: not valid JSON at line 4: Unexpected token }.']);
  });

  it('baseUrl', async () => {
    const { problems } = await problemOf('deepseek', provider('deepseek', { baseUrl: 'api.deepseek.com' }));
    expect(problems).toEqual(['`deepseek`: `baseUrl` must be an http or https address (got "api.deepseek.com").']);
  });

  it('modelsUrl on another origin', async () => {
    const { problems } = await problemOf('deepseek', provider('deepseek', { baseUrl: 'https://api.deepseek.com/v1', modelsUrl: 'https://example.com/models' }));
    expect(problems).toEqual(['`deepseek`: `modelsUrl` must be on the same address as `baseUrl` (https://api.deepseek.com), got https://example.com.']);
  });

  it('a protocol that is not installed', async () => {
    const { problems } = await problemOf('deepseek', provider('deepseek', { protocol: 'openai-compat' }));
    expect(problems).toEqual(['`deepseek`: `protocol` is `openai-compat`, which is not installed. Installed: anthropic-messages, claude-code-cli, openai-chat.']);
  });

  it('defaultModel not in models', async () => {
    const { problems } = await problemOf('deepseek', provider('deepseek', { defaultModel: 'deepseek-v5' }));
    expect(problems).toEqual(['`deepseek`: `defaultModel` `deepseek-v5` is not in `models`.']);
  });

  it('folder and id differ', async () => {
    const { problems } = await problemOf('deep-seek', provider('deepseek'));
    expect(problems).toEqual(['`deepseek`: the folder is `deep-seek` but the id is `deepseek`; they must be the same.']);
  });

  it('a Windows reserved id', async () => {
    for (const id of ['nul', 'COM1', 'con', 'prn', 'aux', 'lpt1', 'LPT9', 'com9']) {
      const { problems, out } = await problemOf(id, provider(id));
      expect(problems).toEqual([`\`${id}\`: this id is a reserved name on Windows; pick another.`]);
      expect(out.registry.has('provider', id)).toBe(false);
      fs.rmSync(path.join(h.modsDir, id), { recursive: true });
    }
  });

  it('a keyEnv outside the pattern', async () => {
    const { problems } = await problemOf('acme', provider('acme', { auth: { style: 'bearer', keyEnv: ['AWS_SECRET_ACCESS_KEY'] } }));
    expect(problems).toEqual(['`acme`: `auth.keyEnv` `AWS_SECRET_ACCESS_KEY` is not a key name Reins will read for a mod; names must end in _API_KEY, _KEY or _TOKEN.']);
  });

  it('a header that holds a key', async () => {
    const { problems, out } = await problemOf('deepseek', provider('deepseek', { headers: { Authorization: 'Bearer sk-abcdefghijklmnop' } }));
    expect(problems).toEqual(['`deepseek`: `headers.Authorization` holds what looks like a key. Keys go in Settings > Providers, never in a mod.']);
    expect(out.registry.has('provider', 'deepseek')).toBe(false);
  });
});

describe('3. collisions', () => {
  it('a user mod with a bundled id of the same kind replaces it', async () => {
    baseProtocols();
    writeBundled('acme', provider('acme', { label: 'Built in' }));
    h.writeMod('acme', provider('acme', { label: 'Mine' }));
    const { mods, registry } = await load();
    expect(mods.filter((m) => m.id === 'acme')).toHaveLength(1);
    expect(find(mods, 'acme')).toMatchObject({ source: 'user', replaces: 'bundled', problems: [] });
    expect(registry.get<LoadedMod>('provider', 'acme')?.source).toBe('user');
  });

  it('a user provider named openai-chat is refused', async () => {
    baseProtocols();
    h.writeMod('openai-chat', provider('openai-chat'));
    const { mods, registry } = await load();
    const user = mods.find((m) => m.id === 'openai-chat' && m.source === 'user');
    expect(user?.problems).toEqual(['`openai-chat` is the id of a built-in protocol; pick another id.']);
    expect(registry.has('provider', 'openai-chat')).toBe(false);
    expect(registry.has('protocol', 'openai-chat')).toBe(true);
  });
});

describe('4. order', () => {
  it('a provider on a user protocol loads after it', async () => {
    h.writeMod('zzz-wire', protocol('zzz-wire'));
    h.writeMod('aaa', provider('aaa', { protocol: 'zzz-wire' }));
    const { mods } = await load();
    expect(find(mods, 'aaa')?.problems).toEqual([]);
    expect(mods.findIndex((m) => m.id === 'zzz-wire')).toBeLessThan(mods.findIndex((m) => m.id === 'aaa'));
  });

  it('a third kind is one registerKind call', async () => {
    const off = registerKind({ id: 'toy', validate: () => [], activate: (mod, host) => host.registry.register('toy', mod.id, mod) });
    try {
      h.writeMod('thing', { reins: 1, id: 'thing', kind: 'toy', version: '1', label: 'Thing' });
      const { registry } = await load();
      expect(registry.has('toy', 'thing')).toBe(true);
    } finally {
      off();
    }
  });
});

describe('5. code', () => {
  const marker = () => path.join(h.home, 'marker.json');
  const source = (version: string) =>
    `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker())}, JSON.stringify({ url: import.meta.url, version: ${JSON.stringify(version)} }));\n` +
    `export default function activate(api) { api.registerProtocol({ id: 'acme-wire' }); }\n`;
  const writeCode = (version: string) => h.writeMod('acme-wire', protocol('acme-wire', { main: 'index.mjs' }), { 'index.mjs': source(version) });
  const ran = () => (fs.existsSync(marker()) ? JSON.parse(fs.readFileSync(marker(), 'utf8')) : undefined);

  it('untrusted code never runs', async () => {
    writeCode('v1');
    const { mods, registry } = await load();
    expect(ran()).toBeUndefined();
    expect(find(mods, 'acme-wire')).toMatchObject({ hasCode: true, trusted: false });
    expect(find(mods, 'acme-wire')?.problems[0]).toMatch(/needs trust/);
    expect(registry.has('protocol', 'acme-wire')).toBe(false);
  });

  it('trusted with the right hash runs from mod-cache, and a changed byte needs trust again', async () => {
    writeCode('v1');
    const hash = find((await load()).mods, 'acme-wire')!.hash!;
    const trusted = (id: string, got: string) => id === 'acme-wire' && got === hash;
    const ok = await load({ trusted });
    expect(find(ok.mods, 'acme-wire')).toMatchObject({ trusted: true, problems: [] });
    expect(ok.registry.has('protocol', 'acme-wire')).toBe(true);
    expect(ok.registry.has('protocol-impl', 'acme-wire')).toBe(true);
    const got = ran();
    expect(got.version).toBe('v1');
    const folder = path.dirname(fileURLToPath(got.url));
    expect(folder).toBe(path.join(h.home, 'mod-cache', hash));

    fs.rmSync(marker());
    writeCode('v1 ');
    const changed = await load({ trusted });
    expect(find(changed.mods, 'acme-wire')?.problems[0]).toMatch(/needs trust/);
    expect(ran()).toBeUndefined();
  });
});

describe('6. a file changed after hashing', () => {
  it('the code that runs is the hashed one', async () => {
    const marker = path.join(h.home, 'marker.json');
    const source = (version: string) =>
      `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ url: import.meta.url, version: ${JSON.stringify(version)} }));\nexport default function activate() {}\n`;
    const dir = h.writeMod('acme-wire', protocol('acme-wire', { main: 'index.mjs' }), { 'index.mjs': source('hashed') });
    const hash = find((await load()).mods, 'acme-wire')!.hash!;
    const { mods } = await load({
      trusted: (_id, got) => got === hash,
      beforeActivate: () => fs.writeFileSync(path.join(dir, 'index.mjs'), source('swapped')),
    });
    expect(find(mods, 'acme-wire')?.problems).toEqual([]);
    const got = JSON.parse(fs.readFileSync(marker, 'utf8'));
    expect(got.version).toBe('hashed');
    expect(path.dirname(fileURLToPath(got.url))).toBe(path.join(h.home, 'mod-cache', hash));
  });
});

describe('7. a bad mod', () => {
  it('does not stop the others, and a manifest version other than 1 is refused', async () => {
    baseProtocols();
    h.writeMod('aaa-broken', {}, {});
    fs.writeFileSync(path.join(h.modsDir, 'aaa-broken', 'mod.json'), '{ nope');
    h.writeMod('bbb-old', provider('bbb-old', { reins: 2 }));
    h.writeMod('ccc-good', provider('ccc-good'));
    const { mods, registry } = await load();
    expect(find(mods, 'aaa-broken')?.problems[0]).toMatch(/not valid JSON/);
    expect(find(mods, 'bbb-old')?.problems).toEqual(['`bbb-old`: `reins` is 2; this Reins reads manifests with `reins` 1.']);
    expect(registry.has('provider', 'bbb-old')).toBe(false);
    expect(find(mods, 'ccc-good')?.problems).toEqual([]);
    expect(registry.has('provider', 'ccc-good')).toBe(true);
  });
});

describe('8. disabled mods', () => {
  it('are listed with enabled false and not registered', async () => {
    baseProtocols();
    h.writeMod('acme', provider('acme'));
    const { mods, registry } = await load({ disabled: new Set(['acme']) });
    expect(find(mods, 'acme')).toMatchObject({ enabled: false, problems: [] });
    expect(registry.has('provider', 'acme')).toBe(false);
  });
});

// Fix round: the Codex review of task 3 (docs/plan/p-task-3-codex-review.md).
describe('fix round', () => {
  const markerOf = (name: string) => path.join(h.home, `${name}.json`);
  const marked = (name: string, body = '') =>
    `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(markerOf(name))}, JSON.stringify({ url: import.meta.url, name: ${JSON.stringify(name)} }));\n${body || 'export default function activate() {}\n'}`;
  const ran = (name: string) => fs.existsSync(markerOf(name));
  const codeMod = (id: string, source: string, extra: object = {}, files: Record<string, string> = {}) =>
    h.writeMod(id, protocol(id, { main: 'index.mjs', ...extra }), { 'index.mjs': source, ...files });
  /** Loads once to learn each code mod's hash, then loads again trusting exactly those. */
  const loadTrusted = async (o: Partial<LoadOptions> = {}) => {
    const first = await load();
    const hashes = new Map(first.mods.flatMap((m) => (m.hash ? [[m.id, m.hash] as const] : [])));
    first.dispose();
    return load({ trusted: (id, hash) => hashes.get(id) === hash, ...o });
  };

  describe('1. one snapshot', () => {
    it('main comes from the manifest that was hashed, not from the first scan', async () => {
      const manifest = (main: string) => JSON.stringify(protocol('acme-wire', { main }));
      const dir = codeMod('acme-wire', marked('other'), {}, { 'safe.mjs': marked('safe') });
      fs.writeFileSync(path.join(dir, 'mod.json'), manifest('safe.mjs'));
      const hash = find((await load()).mods, 'acme-wire')!.hash!;
      fs.writeFileSync(path.join(dir, 'mod.json'), manifest('index.mjs'));
      const { mods } = await load({
        trusted: (_id, got) => got === hash,
        afterScan: () => fs.writeFileSync(path.join(dir, 'mod.json'), manifest('safe.mjs')),
      });
      expect(find(mods, 'acme-wire')?.problems).toEqual([]);
      expect(ran('safe')).toBe(true);
      expect(ran('other')).toBe(false);
    });

    it('a junction inside a mod folder is refused, and the code does not run', async () => {
      const dir = codeMod('acme-wire', marked('linked'));
      const outside = path.join(h.home, 'outside');
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(dir, 'lib'), 'junction');
      const { mods } = await loadTrusted();
      expect(find(mods, 'acme-wire')?.problems).toEqual(['`acme-wire`: a link inside the mod folder is not allowed: lib.']);
      expect(ran('linked')).toBe(false);
    });

    it('a mod folder that is itself a link is refused', async () => {
      const outside = path.join(h.home, 'outside');
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(h.modsDir, 'linked'), 'junction');
      const { mods } = await load();
      expect(find(mods, 'linked')?.problems).toEqual(['`linked`: a link inside the mod folder is not allowed: linked.']);
    });

    it('a mod.json that is a link is refused', async () => {
      const real = path.join(h.home, 'real.json');
      fs.writeFileSync(real, JSON.stringify(protocol('acme-wire')));
      fs.mkdirSync(path.join(h.modsDir, 'acme-wire'));
      try {
        fs.symlinkSync(real, path.join(h.modsDir, 'acme-wire', 'mod.json'));
      } catch {
        return; // this account may not make file links; the junction tests above cover the rule
      }
      const { mods, registry } = await load();
      expect(find(mods, 'acme-wire')?.problems).toEqual(['`acme-wire`: a link inside the mod folder is not allowed: mod.json.']);
      expect(registry.has('protocol', 'acme-wire')).toBe(false);
    });
  });

  describe('2. one mod never rejects the load', () => {
    const others = async (id: string, manifest: unknown, raw?: string) => {
      baseProtocols();
      h.writeMod('zzz-good', provider('zzz-good'));
      const dir = h.writeMod(id, manifest);
      if (raw !== undefined) fs.writeFileSync(path.join(dir, 'mod.json'), raw);
      const out = await load();
      expect(find(out.mods, 'zzz-good')?.problems).toEqual([]);
      return find(out.mods, id)!;
    };

    it('objects with a throwing toString in keyEnv', async () => {
      for (const bad of [{ toString: null }, { toString: {} }]) {
        const mod = await others('acme', provider('acme', { auth: { style: 'bearer', keyEnv: [bad] } }));
        expect(mod.problems).toEqual(['`acme`: `auth.keyEnv` `an object` is not a key name Reins will read for a mod; names must end in _API_KEY, _KEY or _TOKEN.']);
        fs.rmSync(path.join(h.modsDir, 'acme'), { recursive: true });
      }
    });

    it('a deeply nested value is refused before the validators', async () => {
      const deep = '['.repeat(15000) + ']'.repeat(15000);
      const mod = await others('acme', {}, `{"reins":1,"id":"acme","kind":"provider","baseUrl":${deep}}`);
      expect(mod.problems).toEqual(['`~/.reins/mods/acme/mod.json`: is nested more than 32 levels deep; a manifest this deep is refused.']);
    });

    it('a manifest over 256 KB is refused', async () => {
      const mod = await others('acme', {}, JSON.stringify(provider('acme', { description: 'x'.repeat(300 * 1024) })));
      expect(mod.problems[0]).toMatch(/larger than 256 KB/);
    });

    it('a kind that is not text is listed, not dropped', async () => {
      for (const kind of [{ toString: null }, ['protocol']]) {
        const mod = await others('acme', provider('acme', { kind }));
        expect(mod.problems).toEqual(['`acme`: `kind` must be text.']);
        fs.rmSync(path.join(h.modsDir, 'acme'), { recursive: true });
      }
    });

    it('a thrown null, text or odd object becomes a problem line', async () => {
      const throwers = { nul: 'null', txt: '"just text"', obj: '{ toString() { throw new Error("x"); }, get message() { throw new Error("y"); } }' };
      for (const [id, v] of Object.entries(throwers)) codeMod(`t-${id}`, `export default function () { throw ${v}; }\n`);
      codeMod('z-fine', marked('fine'));
      const { mods } = await loadTrusted();
      for (const id of Object.keys(throwers)) expect(find(mods, `t-${id}`)?.problems).toHaveLength(1);
      expect(find(mods, 't-nul')?.problems[0]).toBe('`t-nul`: null');
      expect(find(mods, 't-txt')?.problems[0]).toBe('`t-txt`: "just text"');
      expect(find(mods, 'z-fine')?.problems).toEqual([]);
      expect(ran('fine')).toBe(true);
    });

    it('an unreadable code file is a problem, and the others load', async () => {
      codeMod('acme-wire', marked('locked'), {}, { 'locked.bin': 'x' });
      codeMod('z-fine', marked('fine'));
      const first = await load();
      const hashes = new Map(first.mods.flatMap((m) => (m.hash ? [[m.id, m.hash] as const] : [])));
      const real = fs.readFileSync;
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...a: unknown[]) => {
        if (String(p).endsWith('locked.bin')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return (real as (...x: unknown[]) => unknown)(p, ...a);
      }) as typeof fs.readFileSync);
      try {
        const { mods } = await load({ trusted: (id, hash) => hashes.get(id) === hash });
        expect(find(mods, 'acme-wire')?.problems[0]).toMatch(/failed while loading: EACCES/);
        expect(find(mods, 'z-fine')?.problems).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });

    it('a trusted callback that throws is a problem', async () => {
      codeMod('acme-wire', marked('never'));
      const { mods } = await load({ trusted: () => { throw new Error('boom'); } });
      expect(find(mods, 'acme-wire')?.problems).toEqual(['`acme-wire`: failed while loading: boom']);
    });

    it('malformed code is a problem and the others load', async () => {
      codeMod('a-broken', 'export default function (\n');
      codeMod('z-fine', marked('fine'));
      const { mods } = await loadTrusted();
      expect(find(mods, 'a-broken')?.problems[0]).toMatch(/^`a-broken`: its code did not load: /);
      expect(find(mods, 'z-fine')?.problems).toEqual([]);
    });
  });

  describe('3. a replacement is all or nothing', () => {
    it('a user mod whose code throws leaves the built-in in place', async () => {
      baseProtocols();
      codeMod('openai-chat', 'export default function () { throw new Error("boom"); }\n');
      const { mods, registry } = await loadTrusted();
      expect(registry.get<LoadedMod>('protocol', 'openai-chat')?.source).toBe('bundled');
      const user = mods.find((m) => m.id === 'openai-chat' && m.source === 'user')!;
      expect(user.replaces).toBeUndefined();
      expect(user.problems).toEqual(['`openai-chat`: could not replace the built-in `openai-chat`; the built-in stays: boom']);
      expect(mods.some((m) => m.id === 'openai-chat' && m.source === 'bundled')).toBe(true);
    });

    it('a user code mod replacing a built-in is not trusted for that', async () => {
      baseProtocols();
      codeMod('openai-chat', marked('replacer'));
      const { mods, registry } = await load();
      expect(mods.find((m) => m.source === 'user')?.problems[0]).toMatch(/needs trust/);
      expect(registry.get<LoadedMod>('protocol', 'openai-chat')?.source).toBe('bundled');
      expect(ran('replacer')).toBe(false);
    });
  });

  describe('4. activation is awaited', () => {
    it('a rejected promise rolls the mod back and is a problem', async () => {
      codeMod('acme-wire', `export default async function (api) { api.registerProtocol({ id: 'acme-wire' }); await null; throw new Error('late'); }\n`);
      const { mods, registry } = await loadTrusted();
      expect(find(mods, 'acme-wire')?.problems).toEqual(['`acme-wire`: late']);
      expect(registry.has('protocol', 'acme-wire')).toBe(false);
      expect(registry.has('protocol-impl', 'acme-wire')).toBe(false);
    });

    it('the load waits for an async activate to finish', async () => {
      const g = globalThis as unknown as Record<string, unknown>;
      let release!: () => void;
      g.__modGate = new Promise<void>((r) => { release = r; });
      try {
        codeMod('acme-wire', `export default async function (api) { await globalThis.__modGate; api.registerProtocol({ id: 'acme-wire' }); }\n`);
        const pending = loadTrusted();
        const state = await Promise.race([pending.then(() => 'done'), new Promise((r) => setTimeout(() => r('pending'), 300))]);
        expect(state).toBe('pending');
        release();
        expect((await pending).registry.has('protocol-impl', 'acme-wire')).toBe(true);
      } finally {
        release();
        delete g.__modGate;
      }
    });

    it('registerProtocol after activate has settled throws and registers nothing', async () => {
      const g = globalThis as unknown as Record<string, any>;
      try {
        codeMod('acme-wire', `export default function (api) { globalThis.__lateApi = api; api.registerProtocol({ id: 'acme-wire' }); }\n`);
        const { mods, registry } = await loadTrusted();
        expect(find(mods, 'acme-wire')?.problems).toEqual([]);
        expect(() => g.__lateApi.registerProtocol({ id: 'late-wire' })).toThrow('the api can only be used while the mod activates.');
        expect(registry.has('protocol-impl', 'late-wire')).toBe(false);
        expect(registry.has('protocol-impl', 'acme-wire')).toBe(true);
      } finally {
        delete g.__lateApi;
      }
    });
  });

  describe('5. the cache', () => {
    it('a snapshot that is already there is reused, and one that differs is never rebuilt', async () => {
      codeMod('acme-wire', marked('cached'));
      const first = await loadTrusted();
      const hash = find(first.mods, 'acme-wire')!.hash!;
      const cache = path.join(h.home, 'mod-cache');
      expect(fs.readdirSync(cache)).toEqual([hash]);
      const writes = vi.spyOn(fs, 'writeFileSync');
      try {
        await loadTrusted();
        expect(writes.mock.calls.filter((c) => String(c[0]).includes('mod-cache'))).toEqual([]);
      } finally {
        writes.mockRestore();
      }
      fs.appendFileSync(path.join(cache, hash, 'index.mjs'), '// changed after import\n');
      const { mods } = await loadTrusted();
      expect(find(mods, 'acme-wire')?.problems[0]).toMatch(/exists but does not hold this code/);
      expect(fs.readFileSync(path.join(cache, hash, 'index.mjs'), 'utf8')).toMatch(/changed after import/);
      expect(fs.readdirSync(cache)).toEqual([hash]);
    });
  });

  describe('6. case aliases', () => {
    it('two paths that differ only in case are found', () => {
      expect(caseAlias(['a.mjs', 'sub/B.mjs', 'sub/b.mjs'])).toEqual(['sub/B.mjs', 'sub/b.mjs']);
      expect(caseAlias(['a.mjs', 'b.mjs'])).toBeUndefined();
    });

    it('a mod holding both is refused (where the filesystem keeps both)', async () => {
      const dir = codeMod('acme-wire', marked('alias'));
      fs.writeFileSync(path.join(dir, 'INDEX.mjs'), 'x');
      if (fs.readdirSync(dir).filter((n) => n.toLowerCase() === 'index.mjs').length < 2) return; // a case-insensitive filesystem cannot hold both
      const { mods } = await loadTrusted();
      expect(find(mods, 'acme-wire')?.problems[0]).toMatch(/differ only in upper and lower case/);
    });
  });

  describe('7. one spelling of main', () => {
    it('a main with backslashes or dots is used in one form; a main outside the folder is refused', async () => {
      codeMod('acme-wire', 'x', { main: '.\\sub\\..\\sub\\index.mjs' }, { 'sub/index.mjs': marked('sub') });
      for (const main of ['../x.mjs', '..\\x.mjs', '/x.mjs', 'C:/x.mjs', 'sub/', 7]) {
        h.writeMod(`bad-${String(main).replace(/\W/g, '').toLowerCase()}`, protocol(`bad-${String(main).replace(/\W/g, '').toLowerCase()}`, { main }));
      }
      const { mods } = await loadTrusted();
      expect(find(mods, 'acme-wire')?.problems).toEqual([]);
      expect(ran('sub')).toBe(true);
      for (const m of mods.filter((x) => x.id.startsWith('bad-'))) expect(m.problems).toEqual([`\`${m.id}\`: \`main\` must be a file inside the mod folder.`]);
    });
  });

  describe('8. every entry is listed', () => {
    it('an unknown kind is listed with its words', async () => {
      h.writeMod('acme', provider('acme', { kind: 'gadget' }));
      const { mods } = await load();
      expect(find(mods, 'acme')?.problems).toEqual(['`acme`: `kind` is "gadget", which Reins does not know. Known: block, card, condition, protocol, provider.']);
    });
  });

  describe('9. folder errors', () => {
    it('a missing mods folder is no mods; one that is a file is a problem', async () => {
      const none = await load({ userDir: path.join(h.home, 'nope') });
      expect(none.problems).toEqual([]);
      const file = path.join(h.home, 'afile');
      fs.writeFileSync(file, 'x');
      const bad = await load({ userDir: file });
      expect(bad.problems).toHaveLength(1);
      expect(bad.problems[0]).toMatch(/the mods folder could not be read \(ENOTDIR\)/);
    });

    it('an unreadable mod.json says so, not "missing"', async () => {
      fs.mkdirSync(path.join(h.modsDir, 'acme', 'mod.json'), { recursive: true });
      const { mods } = await load();
      expect(find(mods, 'acme')?.problems[0]).toMatch(/could not be read \(EISDIR\)/);
    });
  });

  describe('Codex mutations', () => {
    it('G1 dispose removes everything a code mod registered', async () => {
      codeMod('acme-wire', `export default function (api) { api.registerProtocol({ id: 'acme-wire' }); api.registerProtocol({ id: 'acme-two' }); }\n`);
      const { registry, dispose } = await loadTrusted();
      expect(registry.ids('protocol-impl')).toEqual(['acme-two', 'acme-wire']);
      dispose();
      expect(registry.ids('protocol-impl')).toEqual([]);
      expect(registry.ids('protocol')).toEqual([]);
    });

    it('G2 version and label are required', async () => {
      h.writeMod('acme-wire', { reins: 1, id: 'acme-wire', kind: 'protocol' });
      const { mods } = await load();
      expect(find(mods, 'acme-wire')?.problems).toEqual(['`acme-wire`: `version` is missing.', '`acme-wire`: `label` is missing.']);
    });

    it('G4 a kind loads after the kinds it names, whatever the order of their ids', async () => {
      const offs = [
        registerKind({ id: 'zzz-early', validate: () => [], activate: (m, host) => host.registry.register('zzz-early', m.id, m) }),
        registerKind({
          id: 'aaa-late',
          after: ['zzz-early'],
          validate: (_raw, { id, registry }) => (registry.has('zzz-early', 'x') ? [] : [`\`${id}\`: the early mod is not loaded yet.`]),
          activate: (m, host) => host.registry.register('aaa-late', m.id, m),
        }),
      ];
      try {
        h.writeMod('x', { reins: 1, id: 'x', kind: 'zzz-early', version: '1', label: 'X' });
        h.writeMod('y', { reins: 1, id: 'y', kind: 'aaa-late', version: '1', label: 'Y' });
        const { mods } = await load();
        expect(find(mods, 'y')?.problems).toEqual([]);
      } finally {
        for (const off of offs) off();
      }
    });

    it('G5 a changed helper file or manifest needs trust again', async () => {
      const dir = codeMod('acme-wire', marked('g5'), {}, { 'helper.mjs': 'export const v = 1;\n' });
      const hash = find((await load()).mods, 'acme-wire')!.hash!;
      const trusted = (_id: string, got: string) => got === hash;
      expect(find((await load({ trusted })).mods, 'acme-wire')?.problems).toEqual([]);
      fs.writeFileSync(path.join(dir, 'helper.mjs'), 'export const v = 2;\n');
      expect(find((await load({ trusted })).mods, 'acme-wire')?.problems[0]).toMatch(/needs trust/);
      fs.writeFileSync(path.join(dir, 'helper.mjs'), 'export const v = 1;\n');
      fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify(protocol('acme-wire', { main: 'index.mjs', label: 'changed' })));
      expect(find((await load({ trusted })).mods, 'acme-wire')?.problems[0]).toMatch(/needs trust/);
    });

    it('G6 a helper file changed after hashing is not the one that runs', async () => {
      const helper = (v: string) => `export const v = ${JSON.stringify(v)};\n`;
      const source = `import fs from 'node:fs';\nimport { v } from './helper.mjs';\nfs.writeFileSync(${JSON.stringify(markerOf('g6'))}, JSON.stringify({ v }));\nexport default function () {}\n`;
      const dir = codeMod('acme-wire', source, {}, { 'helper.mjs': helper('hashed') });
      const hash = find((await load()).mods, 'acme-wire')!.hash!;
      await load({
        trusted: (_id, got) => got === hash,
        beforeActivate: () => fs.writeFileSync(path.join(dir, 'helper.mjs'), helper('swapped')),
      });
      expect(JSON.parse(fs.readFileSync(markerOf('g6'), 'utf8')).v).toBe('hashed');
    });

    it('G7 malformed code does not reject the whole load', async () => {
      codeMod('a-broken', 'export default function (\n');
      codeMod('z-fine', marked('g7'));
      await expect(loadTrusted()).resolves.toBeDefined();
    });

    it('G8 a disabled code mod never runs, even when trusted', async () => {
      codeMod('acme-wire', marked('g8'));
      const { mods } = await loadTrusted({ disabled: new Set(['acme-wire']) });
      expect(find(mods, 'acme-wire')).toMatchObject({ enabled: false, problems: [] });
      expect(ran('g8')).toBe(false);
    });
  });

  describe('round 2 A. the staging folder', () => {
    it('a staging name that is already a link is never written through', async () => {
      codeMod('acme-wire', marked('stage'));
      const hash = find((await load()).mods, 'acme-wire')!.hash!;
      const outside = path.join(h.home, 'outside');
      fs.mkdirSync(outside);
      fs.mkdirSync(path.join(h.home, 'mod-cache'));
      try {
        for (let n = 1; n <= 80; n++) fs.symlinkSync(outside, path.join(h.home, 'mod-cache', `${hash}.tmp-${process.pid}-${n}`), 'junction');
      } catch {
        return; // this account cannot make links
      }
      const { mods } = await load({ trusted: (_id, got) => got === hash });
      expect(find(mods, 'acme-wire')?.problems).toEqual([]);
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('a cache root that is a link is refused', async () => {
      codeMod('acme-wire', marked('root'));
      const hash = find((await load()).mods, 'acme-wire')!.hash!;
      const outside = path.join(h.home, 'outside');
      fs.mkdirSync(outside);
      try {
        fs.symlinkSync(outside, path.join(h.home, 'mod-cache'), 'junction');
      } catch {
        return;
      }
      const { mods } = await load({ trusted: (_id, got) => got === hash });
      expect(find(mods, 'acme-wire')?.problems[0]).toMatch(/is a link, which is not allowed in the code cache/);
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(ran('root')).toBe(false);
    });
  });

  describe('round 2 A2. a final cache folder that is a link', () => {
    it('is refused', async () => {
      codeMod('acme-wire', marked('final'));
      const hash = find((await load()).mods, 'acme-wire')!.hash!;
      const outside = path.join(h.home, 'outside');
      fs.mkdirSync(outside);
      fs.mkdirSync(path.join(h.home, 'mod-cache'));
      try {
        fs.symlinkSync(outside, path.join(h.home, 'mod-cache', hash), 'junction');
      } catch {
        return;
      }
      const { mods } = await load({ trusted: (_id, got) => got === hash });
      expect(find(mods, 'acme-wire')?.problems[0]).toMatch(/is a link, which is not allowed in the code cache/);
      expect(ran('final')).toBe(false);
    });
  });

  describe('round 2 B. a replacement shadows, it never takes the built-in down', () => {
    it('the registry: shadow, dispose reveals the entry below, a plain register of a taken id throws', () => {
      const r = new Registry();
      const base = r.register('k', 'a', 'base');
      expect(() => r.register('k', 'a', 'again')).toThrow(/already registered/);
      const top = r.register('k', 'a', 'top', { shadow: true });
      expect(r.get('k', 'a')).toBe('top');
      top();
      expect(r.get('k', 'a')).toBe('base');
      base();
      expect(r.has('k', 'a')).toBe(false);
    });

    it('a shadow disposer called twice does not remove a later registration', () => {
      const r = new Registry();
      r.register('k', 'a', 'base');
      const first = r.register('k', 'a', 'first', { shadow: true });
      first();
      r.register('k', 'a', 'second', { shadow: true });
      first();
      expect(r.get('k', 'a')).toBe('second');
    });

    /** A kind whose built-in registers `old`, drops it, then registers `current`; every activation notes what `current` was when it began. */
    const withWire = async (user: object | undefined, run: (seen: unknown[], out: Awaited<ReturnType<typeof load>>) => void | Promise<void>) => {
      const seen: unknown[] = [];
      const off = registerKind({
        id: 'wire',
        validate: () => [],
        activate: (mod, host) => {
          seen.push(host.registry.get('wire-entry', 'current'));
          host.registry.register('wire', mod.id, mod);
          if (mod.source === 'bundled') host.registry.register('wire-entry', 'old', mod.source)();
          host.registry.register('wire-entry', 'current', mod.source);
          if ((mod.manifest as { fail?: boolean }).fail) throw new Error('user boom');
          return undefined;
        },
      });
      try {
        writeBundled('dev', { reins: 1, id: 'dev', kind: 'wire', version: '1', label: 'Dev' });
        if (user) h.writeMod('dev', { reins: 1, id: 'dev', kind: 'wire', version: '1', label: 'Mine', ...user });
        await run(seen, await load());
      } finally {
        off();
      }
    };

    it("a failing replacement leaves exactly the built-in's current entries, and the built-in was never down", async () => {
      await withWire({ fail: true }, (seen, { mods, registry }) => {
        expect(registry.ids('wire-entry')).toEqual(['current']);
        expect(registry.get('wire-entry', 'current')).toBe('bundled');
        expect(registry.get<LoadedMod>('wire', 'dev')?.source).toBe('bundled');
        expect(seen).toEqual([undefined, 'bundled']); // while the user mod activated, the built-in's entry was still in view
        const user = mods.find((m) => m.source === 'user')!;
        expect(user.replaces).toBeUndefined();
        expect(user.problems).toEqual(['`dev`: could not replace the built-in `dev`; the built-in stays: user boom']);
      });
    });

    it('a replacement that works is in force, and the final dispose leaves nothing', async () => {
      await withWire({}, (_seen, { mods, registry, dispose }) => {
        expect(registry.get('wire-entry', 'current')).toBe('user');
        expect(registry.get<LoadedMod>('wire', 'dev')?.source).toBe('user');
        expect(mods.filter((m) => m.id === 'dev')).toHaveLength(1);
        expect(find(mods, 'dev')).toMatchObject({ source: 'user', replaces: 'bundled', problems: [] });
        dispose();
        expect(registry.ids('wire')).toEqual([]);
        expect(registry.ids('wire-entry')).toEqual([]);
      });
    });
  });

  describe('round 2 C. the error boundary', () => {
    const withWire2 = async (run: () => Promise<void>) => {
      const off = registerKind({
        id: 'wire2',
        validate: () => [],
        activate: (mod, host) => {
          host.registry.register('wire2', mod.id, mod);
          return () => { throw new Error('cleanup boom'); };
        },
      });
      try {
        await run();
      } finally {
        off();
      }
    };
    const wire2 = (id: string, main?: string) => h.writeMod(id, { reins: 1, id, kind: 'wire2', version: '1', label: id, ...(main ? { main: 'index.mjs' } : {}) }, main ? { 'index.mjs': main } : {});

    it('a disposer that throws never stops the clean-up or hides the first error', async () => {
      await withWire2(async () => {
        wire2('m', 'export default function () { throw new Error("primary"); }\n');
        wire2('ok');
        wire2('z-last');
        const { mods, registry, dispose } = await loadTrusted();
        expect(find(mods, 'm')?.problems).toEqual(['`m`: primary']);
        expect(registry.has('wire2', 'm')).toBe(false);
        expect(find(mods, 'z-last')?.problems).toEqual([]);
        expect(registry.has('wire2', 'ok')).toBe(true);
        expect(() => dispose()).not.toThrow();
        expect(registry.ids('wire2')).toEqual([]);
      });
    });

    it('a revoked proxy thrown by the trust callback, by the code, or returned as the answer is a problem line', async () => {
      const dead = () => {
        const r = Proxy.revocable({}, {});
        r.revoke();
        return r.proxy;
      };
      codeMod('acme-wire', marked('proxy'));
      const thrown = await load({ trusted: () => { throw dead(); } });
      expect(find(thrown.mods, 'acme-wire')?.problems).toEqual(['`acme-wire`: failed while loading: an object']);
      const returned = await load({ trusted: () => dead() as unknown as boolean });
      expect(find(returned.mods, 'acme-wire')?.problems[0]).toMatch(/needs trust/);
      expect(ran('proxy')).toBe(false);
      codeMod('z-throws', `export default function () { const r = Proxy.revocable({}, {}); r.revoke(); throw r.proxy; }\n`);
      const code = await loadTrusted();
      expect(find(code.mods, 'z-throws')?.problems).toEqual(['`z-throws`: an object']);
    });
  });

  describe('round 2 D. limits', () => {
    it('a manifest that grows between lstat and read is read only up to the ceiling', async () => {
      const dir = h.writeMod('acme', provider('acme'));
      baseProtocols();
      const file = path.join(dir, 'mod.json');
      const lstat = fs.lstatSync;
      const read = fs.readSync;
      const readFile = fs.readFileSync;
      const asked: number[] = [];
      const wholeReads: string[] = [];
      let grown = false;
      const s1 = vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, ...a: unknown[]) => {
        const st = (lstat as (...x: unknown[]) => unknown)(p, ...a);
        if (String(p) === file && !grown) {
          grown = true;
          fs.appendFileSync(file, ' '.repeat(2_000_000));
        }
        return st;
      }) as typeof fs.lstatSync);
      const s2 = vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, buf: Buffer, off: number, len: number, pos: number) => {
        asked.push(len);
        return (read as (...x: unknown[]) => number)(fd, buf, off, len, pos);
      }) as typeof fs.readSync);
      const s3 = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...a: unknown[]) => {
        if (String(p) === file) wholeReads.push(String(p));
        return (readFile as (...x: unknown[]) => unknown)(p, ...a);
      }) as typeof fs.readFileSync);
      try {
        const { mods } = await load();
        expect(find(mods, 'acme')?.problems[0]).toMatch(/larger than 256 KB/);
        expect(wholeReads).toEqual([]);
        expect(Math.max(...asked)).toBeLessThanOrEqual(256 * 1024 + 1);
      } finally {
        s1.mockRestore();
        s2.mockRestore();
        s3.mockRestore();
      }
    });

    it('a wide manifest makes at most 20 problems', () => {
      let visits = 0;
      const bad = Array.from({ length: 80000 }, () => ({ get id() { visits++; return undefined; } }));
      const out = kindOf('provider')!.validate({ ...provider('acme'), models: bad }, { id: 'acme', registry: new Registry() });
      expect(out.length).toBeLessThanOrEqual(20);
      expect(visits).toBeLessThanOrEqual(25); // it stopped looking once the budget was spent
      const keys = Array.from({ length: 20000 }, () => 'lower');
      expect(kindOf('provider')!.validate({ ...provider('acme'), auth: { style: 'bearer', keyEnv: keys } }, { id: 'acme', registry: new Registry() }).length).toBeLessThanOrEqual(20);
    });

    it('a manifest that grows after the scan is refused when the snapshot is read', async () => {
      const dir = codeMod('acme-wire', marked('big'));
      const file = path.join(dir, 'mod.json');
      const readFile = fs.readFileSync;
      const whole: string[] = [];
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...a: unknown[]) => {
        if (String(p) === file) whole.push(String(p));
        return (readFile as (...x: unknown[]) => unknown)(p, ...a);
      }) as typeof fs.readFileSync);
      try {
        const { mods } = await load({ trusted: () => true, afterScan: () => fs.appendFileSync(file, ' '.repeat(300 * 1024)) });
        expect(find(mods, 'acme-wire')?.problems[0]).toMatch(/larger than 256 KB/);
        expect(ran('big')).toBe(false);
        expect(whole).toEqual([]); // read up to the ceiling, never whole
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('round 2 E. a folder swapped for a link after the scan', () => {
    it('is refused at the snapshot', async () => {
      const dir = codeMod('acme-wire', marked('swapped'));
      const real = path.join(h.home, 'real-acme-wire');
      const hash = find((await load()).mods, 'acme-wire')!.hash!;
      const { mods } = await load({
        trusted: (_id, got) => got === hash,
        afterScan: () => {
          fs.renameSync(dir, real);
          try {
            fs.symlinkSync(real, dir, 'junction');
          } catch {
            fs.renameSync(real, dir); // cannot make links here
          }
        },
      });
      if (!fs.lstatSync(dir).isSymbolicLink()) return;
      expect(find(mods, 'acme-wire')?.problems).toEqual(['`acme-wire`: a link inside the mod folder is not allowed: acme-wire.']);
      expect(ran('swapped')).toBe(false);
    });
  });

  describe('round 2 F. publication failures', () => {
    it('keeps the first error, says the cache folder is absent, and a failed clean-up changes nothing', async () => {
      codeMod('acme-wire', marked('pub'));
      const first = await load();
      const hash = find(first.mods, 'acme-wire')!.hash!;
      const rename = fs.renameSync;
      const removeTree = fs.rmSync;
      const s1 = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
        if (String(from).includes('.tmp-')) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
        return rename(from, to);
      }) as typeof fs.renameSync);
      const s2 = vi.spyOn(fs, 'rmSync').mockImplementation(((p: fs.PathLike, ...a: unknown[]) => {
        if (String(p).includes('.tmp-')) throw Object.assign(new Error('EPERM: not permitted'), { code: 'EPERM' });
        return (removeTree as (...x: unknown[]) => void)(p, ...a);
      }) as typeof fs.rmSync);
      try {
        const { mods } = await load({ trusted: (_id, got) => got === hash });
        const line = find(mods, 'acme-wire')?.problems[0] ?? '';
        expect(line).toMatch(/could not be put in the cache \(EBUSY: resource busy\)/);
        expect(line).not.toMatch(/exists/);
        expect(ran('pub')).toBe(false);
      } finally {
        s1.mockRestore();
        s2.mockRestore();
      }
    });
  });

  describe('round 2 G. case aliases on a filesystem that cannot hold both', () => {
    it('a listing with INDEX.mjs and index.mjs is refused before any copy', async () => {
      const dir = codeMod('acme-wire', marked('alias2'));
      const fake = path.join(dir, 'INDEX.mjs');
      const readdir = fs.readdirSync;
      const readFile = fs.readFileSync;
      const lstat = fs.lstatSync;
      const s1 = vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, ...a: unknown[]) => {
        const out = (readdir as (...x: unknown[]) => unknown[])(p, ...a);
        const dirent = { name: 'INDEX.mjs', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
        return String(p) === dir ? [...out, dirent] : out;
      }) as unknown as typeof fs.readdirSync);
      const s2 = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...a: unknown[]) =>
        String(p) === fake ? Buffer.from('x') : (readFile as (...x: unknown[]) => unknown)(p, ...a)) as typeof fs.readFileSync);
      const s3 = vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, ...a: unknown[]) =>
        String(p) === fake ? ({ isSymbolicLink: () => false } as fs.Stats) : (lstat as (...x: unknown[]) => unknown)(p, ...a)) as typeof fs.lstatSync);
      try {
        const { mods } = await load({ trusted: () => true });
        expect(find(mods, 'acme-wire')?.problems[0]).toMatch(/differ only in upper and lower case: (INDEX|index)\.mjs, (INDEX|index)\.mjs/);
        expect(ran('alias2')).toBe(false);
        expect(fs.existsSync(path.join(h.home, 'mod-cache'))).toBe(false);
      } finally {
        s1.mockRestore();
        s2.mockRestore();
        s3.mockRestore();
      }
    });
  });
});

describe('the trust hash', () => {
  const f = (rel: string, text: string) => ({ rel, bytes: Buffer.from(text) });

  it('depends on the path of each file, not only on the bytes: swapping two same-length files changes it', () => {
    const a = hashFiles([f('main.mjs', 'AAAA'), f('helper.mjs', 'BBBB')]);
    const b = hashFiles([f('main.mjs', 'BBBB'), f('helper.mjs', 'AAAA')]);
    const renamed = hashFiles([f('other.mjs', 'AAAA'), f('helper.mjs', 'BBBB')]);
    expect(new Set([a, b, renamed]).size).toBe(3);
  });

  it('does not depend on the order the folder was read in', () => {
    const files = [f('b.mjs', '2'), f('a.mjs', '1'), f('sub/c.json', '3')];
    expect(hashFiles([...files].reverse())).toBe(hashFiles(files));
  });

  it('does not let a file name run into the next file (framing)', () => {
    expect(hashFiles([f('a', 'xb'), f('c', 'y')])).not.toBe(hashFiles([f('a', 'x'), f('bc', 'y')]));
  });
});
