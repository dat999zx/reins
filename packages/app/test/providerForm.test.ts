import { describe, it, expect } from 'vitest';
import { editBody, emptyForm, errorsByField, formToManifest, manifestToForm, type ProviderForm } from '../src/providerForm.js';

const KEY = 'sk-test-0123456789abcdef';
const base = (over: Partial<ProviderForm> = {}): ProviderForm => ({
  ...emptyForm('chat-wire'), label: 'Mine', id: 'mine', baseUrl: 'https://api.mine.test/v1', auth: 'bearer', keyEnv: 'MINE_API_KEY',
  models: [{ id: 'm1', context: '8192', maxOutput: '2048', tools: 'yes', priceIn: '1.5', priceOut: '3', extra: {}, priceExtra: {} }],
  defaultModel: 'm1', ...over,
});
const roundTrip = (f: ProviderForm) => manifestToForm(formToManifest(f).manifest);

describe('formToManifest and manifestToForm', () => {
  it('round trips a bearer endpoint with every field', () => {
    const f = base({
      modelsUrl: 'https://api.mine.test/v1/models', priceIn: '0.5', priceOut: '1',
      models: [
        { id: 'm1', context: '8192', maxOutput: '2048', tools: 'yes', priceIn: '1.5', priceOut: '3', extra: { label: 'M one' }, priceExtra: { cacheRead: 0.1 } },
        { id: 'm2', context: '', maxOutput: '', tools: 'no', priceIn: '', priceOut: '', extra: {}, priceExtra: {} },
      ],
      efforts: [{ id: 'hi', label: 'High', body: '{"reasoning_effort":"high"}' }, { id: 'lo', label: 'Low', body: '' }], defaultEffort: 'lo',
    });
    expect(roundTrip(f)).toEqual(f);
  });

  it('round trips a header-auth endpoint and a no-auth endpoint', () => {
    const h = base({ auth: 'header', header: 'x-api-key', keyEnv: 'A_API_KEY, B_API_KEY' });
    expect(formToManifest(h).manifest.auth).toEqual({ style: 'header', keyEnv: ['A_API_KEY', 'B_API_KEY'], header: 'x-api-key' });
    expect(roundTrip(h)).toEqual(h);
    const n = base({ auth: 'none', keyEnv: '', priceIn: '0', priceOut: '0' });
    expect(formToManifest(n).manifest.auth).toEqual({ style: 'none', keyEnv: [] });
    expect(formToManifest(n).manifest.price).toEqual({ input: 0, output: 0 });
    expect(roundTrip(n)).toEqual(n);
  });

  it('manifest to form to manifest changes nothing', () => {
    const m = formToManifest(base({ efforts: [{ id: 'hi', label: 'High', body: '{"a":{"b":1}}' }], defaultEffort: 'hi', priceIn: '2', priceOut: '4' })).manifest;
    expect(formToManifest(manifestToForm(m)).manifest).toEqual(m);
  });

  it('never puts the key in the manifest', () => {
    const f = base({ key: KEY });
    const { manifest } = formToManifest(f);
    expect(JSON.stringify(manifest)).not.toContain(KEY);
    expect(manifest).not.toHaveProperty('key');
    expect(manifestToForm(manifest).key).toBe('');
    expect(manifest.auth).toEqual({ style: 'bearer', keyEnv: ['MINE_API_KEY'] });
  });

  it('leaves out every empty optional field', () => {
    const m = formToManifest(base({ models: [{ ...base().models[0]!, context: '', maxOutput: '', tools: '', priceIn: '', priceOut: '' }] })).manifest;
    expect(m).toEqual({
      id: 'mine', label: 'Mine', protocol: 'chat-wire', baseUrl: 'https://api.mine.test/v1', auth: { style: 'bearer', keyEnv: ['MINE_API_KEY'] },
      defaultModel: 'm1', models: [{ id: 'm1' }],
    });
  });

  it('puts bad JSON in an effort body beside the efforts field, and a non-object too', () => {
    const bad = formToManifest(base({ efforts: [{ id: 'hi', label: 'High', body: '{"a":' }] }));
    expect(bad.errors.efforts).toMatch(/effort "hi" is not valid JSON/);
    expect(formToManifest(base({ efforts: [{ id: 'hi', label: 'High', body: '[1]' }] })).errors.efforts).toMatch(/must be a JSON object/);
    expect(formToManifest(base()).errors).toEqual({});
  });

  it('says a price or window that is not a number, beside its field', () => {
    expect(formToManifest(base({ priceIn: 'cheap' })).errors.price).toMatch(/must be a number/);
    expect(formToManifest(base({ models: [{ ...base().models[0]!, context: 'big' }] })).errors.models).toMatch(/window must be a number/i);
  });
});

describe('editBody', () => {
  it('sends the owned fields, nulls one the user emptied, and never the id or protocol', () => {
    const original = formToManifest(base({ modelsUrl: 'https://api.mine.test/v1/models', priceIn: '1', priceOut: '2' })).manifest;
    const { body } = editBody(base({ label: 'Mine 2' }), original);
    expect(body.label).toBe('Mine 2');
    expect(body.modelsUrl).toBeNull();
    expect(body.price).toBeNull();
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('protocol');
    expect(body).not.toHaveProperty('key');
    expect(body).not.toHaveProperty('efforts');
  });
});

describe('errorsByField', () => {
  it('puts the server words beside the field they name', () => {
    const r = errorsByField([
      '`mine`: `baseUrl` must be an http or https address (got "x").',
      '`mine`: `auth.keyEnv` `AWS_SECRET_ACCESS_KEY` is not a key name Reins will read for a mod; names must end in _API_KEY, _KEY or _TOKEN.',
      '`mine`: `defaultModel` `zz` is not in `models`.',
      '`mine`: `models.m1.price.input` must be a number of 0 or more (got "x").',
      '`mine`: `price.output` is missing; a price needs both input and output.',
      '`label` is missing.',
      '`auth.header` must name the header that carries the key.',
      '`auth.style` must be bearer, header or none.',
      '`mine`: `protocol` `x` is not an API protocol. A custom endpoint needs one.',
      'The id must be lowercase letters, digits and dashes, start with a letter or digit, be at most 40 long, and not be a name Windows reserves.',
      'The key must be at least 8 characters. Reins can hide a longer key from logs and errors, not a shorter one.',
      '`modelsUrl` must be on the same address as `baseUrl` (a), got b.',
    ]);
    expect(Object.keys(r.byField).sort()).toEqual(['auth', 'baseUrl', 'defaultModel', 'header', 'id', 'key', 'keyEnv', 'label', 'models', 'modelsUrl', 'price', 'protocol']);
    expect(r.byField.baseUrl).toEqual(['`baseUrl` must be an http or https address (got "x").']);
    expect(r.byField.models).toHaveLength(1);
    expect(r.general).toEqual([]);
  });

  it('sends a word it cannot place to the general line', () => {
    const r = errorsByField(['The manifest is larger than 256 KB.', '`mine`: `headers` must be an object of text values.']);
    expect(r.byField).toEqual({});
    expect(r.general).toHaveLength(2);
  });
});
