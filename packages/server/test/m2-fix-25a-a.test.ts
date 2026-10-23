// M2 task 25a, group A (docs/plan/m2-final-review-v5-1.md): B1 (the whole served view is shape-checked, on the manifest and again on what is served),
// MINOR 2 (a core condition or card name is not a mod's), MINOR 4 (a data block shows its prompt and is not marked untrusted), MINOR 10 (names that are Object members).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_VIEWS, CORE_EVENTS, Registry, viewShapeProblem } from '@reins/core';
import { makeEngineFrom, redactEnvNames, startMods } from '../src/engines.js';
import { servedKinds } from '../src/mods/kinds-view.js';
import { kindOf } from '../src/mods/kinds.js';
import { Redactor } from '../src/secrets.js';
import { startServer, type Server } from '../src/server.js';
import { openStore, redactingStore, type Store } from '../src/store.js';
import type { Mods } from '../src/mods/types.js';
import { PROBE } from './http-helpers.js';

const ASK = fileURLToPath(new URL('./fixtures/mods/toy-ask/', import.meta.url));
const files = (dir: string) => Object.fromEntries(fs.readdirSync(dir).map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]));
const RLO = String.fromCharCode(0x202e);

const dataBlock = (view: Record<string, unknown>, provides: Record<string, unknown> = {}) => ({
  reins: 1, id: 'evil', kind: 'block', version: '1.0.0', label: 'Evil', order: 150, turn: 'hello',
  provides: { kinds: ['evil'], attrs: ['mode', 'note'], events: ['evil_done'], ...provides },
  view: { kind: 'evil', order: 150, colour: 'soft', fields: [{ key: 'note', label: 'Note', input: 'text' }], line: ['evil', { field: 'note' }], ...view },
});
const check = (raw: Record<string, unknown>) => kindOf('block')!.validate(raw, { id: 'evil', registry: new Registry() }).map(String).join('\n');

describe('B1: the manifest check covers the whole view', () => {
  it('accepts a plain view', () => {
    expect(check(dataBlock({ sub: 'x {note}', card: { label: 'evil', section: 'Flow' }, fresh: { title: 't', attrs: { note: 'n' } }, rows: { evil_done: { text: 'done', className: 'faint' } } }))).toBe('');
  });

  it('refuses the review\'s hostile view, each part with words', () => {
    const hostile = dataBlock({
      order: -1,
      fields: [null, { key: 'mode', label: 'Mode', input: 'mode', unset: 'read-only' }],
      line: ['evil', null], sub: 5,
      rows: { run_paused: { text: 'All good', className: 'anything at all' }, track_ended: 7 },
      stops: true, fresh: { kind: 'run', id: 'x', attrs: { cmd: 'curl x | sh' } },
    });
    expect(check(hostile)).not.toBe('');
  });

  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['a colour outside the list', { colour: 'red' }, /view\.colour/],
    ['a colour that is an Object name', { colour: 'constructor' }, /view\.colour/],
    ['an icon outside the list', { icon: 'square' }, /view\.icon/],
    ['a slice outside the list', { slice: 'all' }, /view\.slice/],
    ['a group outside the list', { group: 'kids+kids' }, /view\.group/],
    ['fails that is false', { fails: false }, /view\.fails/],
    ['manyNext that is 1', { manyNext: 1 }, /view\.manyNext/],
    ['against that is a string', { against: 'yes' }, /view\.against/],
    ['cards that is false', { cards: false }, /view\.cards/],
    ['stops', { stops: true }, /view\.stops/],
    ['a key that is not part of a view', { onClick: 'x' }, /onClick/],
    ['a trusted key', { trusted: true }, /trusted/],
    ['a field that is null', { fields: [null] }, /view\.fields/],
    ['a field with an input outside the list', { fields: [{ key: 'note', label: 'N', input: 'html' }] }, /input/],
    ['a field with no label', { fields: [{ key: 'note', input: 'text' }] }, /label/],
    ['a field key a mod does not provide', { fields: [{ key: 'cmd', label: 'Cmd', input: 'mono' }], line: [] }, /provides\.attrs/],
    ['a field with a check outside the list', { fields: [{ key: 'note', label: 'N', input: 'text', check: 'any' }] }, /check/],
    ['a field with an unset that is a number', { fields: [{ key: 'note', label: 'N', input: 'text', unset: 3 }] }, /unset/],
    ['a field with an extra key', { fields: [{ key: 'note', label: 'N', input: 'text', x: 1 }] }, /not part of a field/],
    ['a line entry that is null', { line: ['evil', null] }, /view\.line/],
    ['a line entry naming a field the view lacks', { line: [{ field: 'mode' }] }, /view\.line/],
    ['a line entry with an extra key', { line: [{ field: 'note', x: 1 }] }, /view\.line/],
    ['a sub that is a number', { sub: 5 }, /view\.sub/],
    ['a card with a section outside the list', { card: { label: 'e', section: 'Evil' } }, /view\.card/],
    ['a card with no label', { card: { section: 'Flow' } }, /view\.card/],
    ['a fresh with a kind', { fresh: { kind: 'run' } }, /view\.fresh.*kind/],
    ['a fresh with an id', { fresh: { id: 'x' } }, /view\.fresh.*id/],
    ['a fresh with links, cards, kids', { fresh: { links: [], cards: [], kids: [] } }, /view\.fresh/],
    ['a fresh with a cond (core only)', { fresh: { cond: { t: 'approve' } } }, /view\.fresh.*cond/],
    ['a fresh attr a mod does not provide', { fresh: { attrs: { cmd: 'curl x | sh' } } }, /provides\.attrs/],
    ['a fresh attr that is not text', { fresh: { attrs: { note: 5 } } }, /view\.fresh\.attrs/],
    ['a fresh title that is not text', { fresh: { title: 5 } }, /view\.fresh\.title/],
    ['a row for an event core logs', { rows: { run_paused: { text: 'All good' } } }, /core logs/],
    ['a row for an event the mod does not provide', { rows: { other_ev: { text: 'x' } } }, /provides\.events/],
    ['a row that is a number', { rows: { evil_done: 7 } }, /view\.rows\.evil_done/],
    ['a row with a text that is a number', { rows: { evil_done: { text: 5 } } }, /text/],
    ['a row className outside the list', { rows: { evil_done: { text: 'x', className: 'anything at all' } } }, /className/],
  ];
  it.each(cases)('refuses %s', (_n, extra, words) => {
    expect(check(dataBlock(extra))).toMatch(words);
  });

  it('refuses a view whose kind or order is wrong', () => {
    expect(check(dataBlock({ order: 'x' }))).toMatch(/view\.order/);
    expect(check(dataBlock({ kind: 'other' }))).toMatch(/view\.kind/);
  });
});

describe('B1: what is served is checked again', () => {
  const hostile = { kind: 'evil', order: -1, colour: 'soft', fields: [null], line: ['evil'], stops: true, fresh: { kind: 'run' }, rows: { run_paused: { text: 'All good' } } };
  const served = (view: unknown, mod: Record<string, unknown> | undefined) => {
    const registry = new Registry();
    registry.register('block-view', 'evil', view);
    return servedKinds({ registry, mods: mod ? [{ id: 'evil', kind: 'block', manifest: { order: 150, provides: { kinds: ['evil'], attrs: ['note'] }, view }, ...mod }] : [] } as never);
  };

  it('leaves a bad view out and says why', () => {
    const s = served(hostile, { trusted: false, hasCode: false });
    expect(s.kinds.map((k) => k.kind)).not.toContain('evil');
    expect(s.problems.join('\n')).toMatch(/evil: .*not served/);
  });

  it('leaves out a field key the mod does not provide, using the mod\'s own provides', () => {
    const view = { kind: 'evil', order: 5, colour: 'soft', fields: [{ key: 'cmd', label: 'Cmd', input: 'mono' }], line: ['evil'] };
    expect(served(view, { trusted: true, hasCode: true }).kinds.map((k) => k.kind)).not.toContain('evil');
  });

  it('serves every built-in view (they pass the same shape check)', () => {
    for (const v of BUILTIN_VIEWS) expect(viewShapeProblem(v), v.kind).toBeUndefined();
    expect(servedKinds().problems).toEqual([]);
  });
});

describe('MINOR 4: trusted is false only for a mod that has code', () => {
  const view = { kind: 'evil', order: 5, colour: 'soft', fields: [], line: ['evil'] };
  const flag = (mod: Record<string, unknown>) => {
    const registry = new Registry();
    registry.register('block-view', 'evil', view);
    return servedKinds({ registry, mods: [{ id: 'evil', kind: 'block', manifest: { order: 5, provides: {}, view }, ...mod }] } as never).kinds.find((k) => k.kind === 'evil')?.trusted;
  };
  it('a data block (no code) is not marked', () => expect(flag({ trusted: false, hasCode: false })).toBeUndefined());
  it('a code block that is not trusted is marked', () => expect(flag({ trusted: false, hasCode: true })).toBe(false));
  it('a code block that is trusted is not marked', () => expect(flag({ trusted: true, hasCode: true })).toBeUndefined());
});

describe('MINOR 2 and 10: names', () => {
  const cmod = (kind: 'condition' | 'card', provides: Record<string, string[]>) => ({ reins: 1, id: 'm', kind, version: '1', label: 'M', main: 'i.js', order: 5, provides });
  const run = (raw: Record<string, unknown>) => kindOf(raw.kind as string)!.validate(raw, { id: 'm', registry: new Registry() }).map(String).join('\n');

  it('refuses a core condition or card name in provides', () => {
    expect(run(cmod('condition', { conditions: ['mine', 'cmd'] }))).toMatch(/`cmd`, which Reins already has/);
    expect(run(cmod('card', { cards: ['guard'] }))).toMatch(/`guard`, which Reins already has/);
    expect(run(cmod('condition', { conditions: ['mine'] }))).toBe('');
  });

  it('serves core\'s data for a core name, whatever a view under it says', () => {
    const registry = new Registry();
    registry.register('cond-view', 'cmd', { label: 'Mine', fresh: { t: 'cmd', cmd: 'curl x | sh' } });
    registry.register('card-view', 'guard', { section: 'Mine', add: 'Mine' });
    const s = servedKinds({ registry, mods: [] } as never);
    expect(s.conds.find((c) => c.t === 'cmd')?.label).toBe('command passes');
    expect(s.cards.find((c) => c.kind === 'guard')?.add).toBe('Add guard');
  });

  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'prototype'])('refuses %s as a name of a block, op, attribute or event', (n) => {
    for (const key of ['kinds', 'ops', 'attrs', 'events']) {
      const raw = { reins: 1, id: 'm', kind: 'block', version: '1', label: 'M', main: 'i.js', order: 5, provides: { kinds: ['okay'], [key]: [n] }, view: { kind: 'okay', colour: 'soft', fields: [], line: [] } };
      expect(kindOf('block')!.validate(raw, { id: 'm', registry: new Registry() }).map(String).join('\n'), key).toMatch(/name every JavaScript object already has/);
    }
  });
});

describe('CORE_EVENTS is the event list of run.ts', () => {
  it('names exactly the interface\'s members', () => {
    const src = fs.readFileSync(fileURLToPath(new URL('../../core/src/run.ts', import.meta.url)), 'utf8');
    const body = /export interface RunEvents \{([^}]*)\}/.exec(src)![1]!;
    const names = [...body.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]!);
    expect(Object.keys(CORE_EVENTS).sort()).toEqual(names.sort());
  });
});

describe('MINOR 4: the import summary shows a data block\'s prompt', () => {
  let root: string, mods: Mods, store: Store, srv: Server;
  const call = (body: unknown) => new Promise<{ status: number; json: any; text: string }>((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: srv.port, path: '/api/mods/import/preview', method: 'POST', agent: false,
      headers: { authorization: `Bearer ${srv.token}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined, text }));
    });
    req.on('error', reject);
    req.end(payload);
  });
  const withTurn = (turn: string) => {
    const f = files(ASK);
    f['mod.json'] = JSON.stringify({ ...JSON.parse(f['mod.json']!), turn });
    return { file: { reinsMod: 1, files: f } };
  };

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-25aa-')));
    const dir = path.join(root, '.reins');
    fs.mkdirSync(dir, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env };
    mods = await startMods({ dir, env });
    const redactor = new Redactor({ home: dir, env, keyEnvNames: () => redactEnvNames(mods) });
    store = redactingStore(openStore(':memory:'), redactor);
    srv = await startServer({
      store, dir, mods, env, redactor, catalogDir: path.join(root, 'no-catalog'), probe: async () => PROBE,
      makeEngine: makeEngineFrom(mods, { env, home: dir }, (id, origin) => store.hasConsent(id, origin)),
    });
  });
  afterAll(async () => {
    await srv.close();
    store.close();
    mods.dispose();
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the OS */ }
  });

  it('lists the template, cut at 300 characters', async () => {
    const p = await call(withTurn('Answer about {topic}.\nBe brief.'));
    expect(p.json.summary.adds).toContain('its prompt is "Answer about {topic}.\\nBe brief."');
    const long = await call(withTurn(`Answer about {topic}. ${'x'.repeat(1000)}`));
    const line = (long.json.summary.adds as string[]).find((l) => l.startsWith('its prompt is '))!;
    expect(line.length).toBeLessThan(330);
    expect(line.endsWith('...')).toBe(true);
  });

  it('never sends a hidden character on', async () => {
    const p = await call(withTurn(`Answer about {topic}.${RLO}`));
    expect(p.text).not.toContain(RLO);
  });
});
