import { describe, it, expect } from 'vitest';
import { AGENTS_LINE, apiProtocols, keysLine, otherMeta, rowInfo, statusOf, stopsLine, usedBy, type ModRow } from '../src/providersStatus.js';

const manifest = { id: 'deep', protocol: 'chat-wire', baseUrl: 'https://api.deep.test/v1', auth: { style: 'bearer', keyEnv: ['DEEP_API_KEY'] }, models: [{ id: 'a' }, { id: 'b' }] };
const row = (over: Partial<ModRow> = {}): ModRow => ({
  id: 'deep', kind: 'provider', label: 'Deep', enabled: true, bundled: false, source: 'installed', problems: [], host: 'api.deep.test',
  key: { state: 'set', source: 'Reins' }, manifest, ...over,
});

describe('statusOf (spec 7.4 words)', () => {
  it('has a word for each state', () => {
    expect(statusOf(row())).toBe('ready');
    expect(statusOf(row({ key: { state: 'missing' } }))).toBe('key missing: set DEEP_API_KEY or add a key');
    expect(statusOf(row({ key: { state: 'missing' }, manifest: { ...manifest, auth: { style: 'bearer', keyEnv: ['A_API_KEY', 'B_API_KEY'] } } }))).toBe('key missing: set A_API_KEY or B_API_KEY or add a key');
    expect(statusOf(row({ key: { state: 'missing' }, manifest: { ...manifest, auth: { style: 'bearer', keyEnv: [] } } }))).toBe('key missing: add a key');
    expect(statusOf(row({ problems: ['`deep`: `protocol` is `weird`, which is not installed. Installed: chat-wire.'], manifest: { ...manifest, protocol: 'weird' } }))).toBe('needs protocol weird');
    expect(statusOf(row({ enabled: false }))).toBe('disabled');
    expect(statusOf(row({ problems: ['`deep`: `baseUrl` is wrong.', 'second'] }))).toBe('invalid: `deep`: `baseUrl` is wrong. second');
    expect(statusOf(row({ trust: 'needs-trust' }))).toBe('needs trust');
    expect(statusOf(row({ trust: 'restart', problems: ['`deep`: restart to run the new code.'] }))).toBe('restart to run the new code');
  });

  it('says disabled before anything else, and no key word for a keyless provider', () => {
    expect(statusOf(row({ enabled: false, key: { state: 'missing' } }))).toBe('disabled');
    expect(statusOf(row({ key: { state: 'none' }, manifest: { ...manifest, auth: { style: 'none', keyEnv: [] } } }))).toBe('ready');
  });
});

describe('rowInfo', () => {
  it('shows the host, the model count, the untested badge and the shadow line', () => {
    const i = rowInfo(row({ manifest: { ...manifest, untested: true }, replaces: 'bundled' }));
    expect(i).toMatchObject({ host: 'api.deep.test', models: 2, untested: true, replaces: 'replaces the built-in deep' });
    const plain = rowInfo(row());
    expect(plain.untested).toBe(false);
    expect(plain.replaces).toBeUndefined();
  });

  it('shows "key set" for the Reins file, "key set (NAME)" for a variable, "no key" for none, and Clear key only for a key Reins holds (spec 8.1)', () => {
    expect(rowInfo(row()).keyShown).toBe('key set');
    expect(rowInfo(row()).canClearKey).toBe(true);
    expect(rowInfo(row({ key: { state: 'set', source: 'DEEP_API_KEY' } }))).toMatchObject({ keyShown: 'key set (DEEP_API_KEY)', canClearKey: false, canSetKey: true });
    expect(rowInfo(row({ key: { state: 'missing' } }))).toMatchObject({ keyShown: 'no key', canClearKey: false });
  });

  it('hides key buttons and Test connection for the built-in program provider, and Re-install for a custom one', () => {
    const cc = rowInfo({ id: 'built-in', kind: 'provider', label: 'Built-in', enabled: true, bundled: true, source: 'bundled', problems: [], manifest: { protocol: 'cli-wire', baseUrl: 'https://api.builtin.test', models: [] } });
    expect(cc).toMatchObject({ canSetKey: false, canClearKey: false, canTest: false, canEdit: false, canRemove: false, keyShown: undefined });
    expect(rowInfo(row({ source: 'custom' })).canReinstall).toBe(false);
    expect(rowInfo(row()).canReinstall).toBe(true);
  });

  it('a keyless provider can be tested but has no key buttons', () => {
    const i = rowInfo(row({ key: { state: 'none' }, manifest: { ...manifest, auth: { style: 'none', keyEnv: [] } } }));
    expect(i).toMatchObject({ canTest: true, canSetKey: false, keyShown: undefined });
  });
});

describe('Protocols and other mods (S5)', () => {
  const proto = (id: string, over: Partial<ModRow> = {}): ModRow => ({ id, kind: 'protocol', label: id.toUpperCase(), enabled: true, bundled: false, source: 'custom', problems: [], ...over });
  const code = { hash: 'h'.repeat(64), codePrompt: 'prompt' };

  it('maps a protocol row to the status words: ready, disabled, needs trust, restart, invalid', () => {
    expect(statusOf(proto('wire'))).toBe('ready');
    expect(statusOf(proto('wire', { enabled: false }))).toBe('disabled');
    expect(statusOf(proto('wire', { trust: 'needs-trust', ...code }))).toBe('needs trust');
    expect(statusOf(proto('wire', { trust: 'restart', problems: ['`wire`: restart to run the new code.'] }))).toBe('restart to run the new code');
    expect(statusOf(proto('wire', { trust: 'trusted' }))).toBe('ready');
    expect(statusOf(proto('wire', { problems: ['bad'] }))).toBe('invalid: bad');
  });
  it('Trust shows only for a mod that needs trust and has the hash and the prompt', () => {
    expect(rowInfo(proto('wire', { trust: 'needs-trust', ...code })).canTrust).toBe(true);
    expect(rowInfo(proto('wire', { trust: 'needs-trust' })).canTrust).toBe(false);
    expect(rowInfo(proto('wire', { trust: 'trusted', ...code })).canTrust).toBe(false);
    expect(rowInfo(proto('wire', { trust: 'restart', ...code })).canTrust).toBe(false);
    expect(rowInfo(proto('wire')).canTrust).toBe(false);
  });
  it('a protocol cannot be edited or tested; a user one can be removed, a bundled one not', () => {
    expect(rowInfo(proto('wire'))).toMatchObject({ canEdit: false, canTest: false, canSetKey: false, canRemove: true });
    expect(rowInfo(proto('wire', { bundled: true, source: 'bundled' })).canRemove).toBe(false);
  });
  it('lists which providers use a protocol, by label, and says it in the second line', () => {
    const rows = [proto('chat-wire'), row({ id: 'a', label: 'Alpha', manifest: { protocol: 'chat-wire' } }), row({ id: 'b', label: 'Beta', manifest: { protocol: 'other' } }), row({ id: 'c', label: 'Gamma', manifest: { protocol: 'chat-wire' } })];
    expect(usedBy(rows, 'chat-wire')).toEqual(['Alpha', 'Gamma']);
    expect(usedBy(rows, 'nobody')).toEqual([]);
    expect(otherMeta(rows[0]!, ['Alpha', 'Gamma'])).toBe('protocol · user · used by Alpha, Gamma');
    expect(otherMeta(proto('x', { bundled: true }), [])).toBe('protocol · bundled');
  });
  it('the confirm line names the providers that will stop working', () => {
    expect(stopsLine(['Alpha', 'Gamma'])).toBe('Providers that use it will stop working: Alpha, Gamma');
  });
});

describe('apiProtocols', () => {
  it('lists the working protocols a built-in provider does not use', () => {
    const proto = (id: string, over: Partial<ModRow> = {}): ModRow => ({ id, kind: 'protocol', label: id, enabled: true, bundled: true, source: 'bundled', problems: [], ...over });
    const cc: ModRow = { ...row({ id: 'built-in', bundled: true, source: 'bundled' }), manifest: { protocol: 'cli-wire' } };
    expect(apiProtocols([proto('chat-wire'), proto('cli-wire'), proto('off', { enabled: false }), proto('bad', { problems: ['x'] }), cc]).map((p) => p.id)).toEqual(['chat-wire']);
  });
});

describe('the two fixed lines', () => {
  it('are the words of spec 7.4', () => {
    expect(keysLine('C:\\Users\\me\\.reins\\secrets.json')).toBe('Keys are stored in plain text in C:\\Users\\me\\.reins\\secrets.json, readable by programs running as you. An environment variable always works instead.');
    expect(keysLine('/home/me/.reins/secrets.json')).not.toContain('<home>');
    expect(AGENTS_LINE).toBe('Sessions on API providers do not read CLAUDE.md; put shared rules in AGENTS.md.');
  });
});
