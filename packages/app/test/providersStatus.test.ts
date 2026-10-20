import { describe, it, expect } from 'vitest';
import { AGENTS_LINE, KEYS_LINE, apiProtocols, rowInfo, statusOf, type ModRow } from '../src/providersStatus.js';

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

  it('shows only "key set" or "no key", and Clear key only for a key Reins holds', () => {
    expect(rowInfo(row()).keyShown).toBe('key set');
    expect(rowInfo(row()).canClearKey).toBe(true);
    expect(rowInfo(row({ key: { state: 'set', source: 'DEEP_API_KEY' } }))).toMatchObject({ keyShown: 'key set', canClearKey: false, canSetKey: true });
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

describe('apiProtocols', () => {
  it('lists the working protocols a built-in provider does not use', () => {
    const proto = (id: string, over: Partial<ModRow> = {}): ModRow => ({ id, kind: 'protocol', label: id, enabled: true, bundled: true, source: 'bundled', problems: [], ...over });
    const cc: ModRow = { ...row({ id: 'built-in', bundled: true, source: 'bundled' }), manifest: { protocol: 'cli-wire' } };
    expect(apiProtocols([proto('chat-wire'), proto('cli-wire'), proto('off', { enabled: false }), proto('bad', { problems: ['x'] }), cc]).map((p) => p.id)).toEqual(['chat-wire']);
  });
});

describe('the two fixed lines', () => {
  it('are the words of spec 7.4', () => {
    expect(KEYS_LINE).toBe('Keys are stored in plain text in <home>/secrets.json, readable by programs running as you. An environment variable always works instead.');
    expect(AGENTS_LINE).toBe('Sessions on API providers do not read CLAUDE.md; put shared rules in AGENTS.md.');
  });
});
