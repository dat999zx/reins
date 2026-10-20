// Milestone P, Task 23 (spec 7.4 to 7.6, 7.8, 8.1): Settings > Providers in headless Chromium against a real server, the real loader and a
// fake provider server that records every request. No network, fake keys only.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { keyEnvNames, makeEngineFrom, startMods } from '../src/engines.js';
import { Redactor } from '../src/secrets.js';
import { startServer, type Server } from '../src/server.js';
import { openStore, type Store } from '../src/store.js';
import type { Mods } from '../src/mods/types.js';
import { startFakeProvider } from './fake-provider.js';
import { PROBE } from './http-helpers.js';

const APP = fileURLToPath(new URL('../../app/dist/', import.meta.url));
const INDEX = path.join(APP, 'index.html');
const skip = !fs.existsSync(INDEX) && !process.env.CI;
const T = 120_000;
const W = 15_000;
const KEY = 'sk-form-0123456789abcdef';
const KEY2 = 'sk-shown-fedcba9876543210';
const KEYS_LINE = 'Keys are stored in plain text in <home>/secrets.json, readable by programs running as you. An environment variable always works instead.';
const AGENTS_LINE = 'Sessions on API providers do not read CLAUDE.md; put shared rules in AGENTS.md.';

describe.skipIf(skip)('Settings > Providers (spec 7.4 to 7.6)', () => {
  let browser: Browser | undefined;
  let srv: Server | undefined;
  let store: Store | undefined;
  let mods: Mods | undefined;
  let fake: Awaited<ReturnType<typeof startFakeProvider>> | undefined;
  let root = '';
  afterAll(async () => {
    await browser?.close();
    await srv?.close();
    store?.close();
    mods?.dispose();
    await fake?.close();
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the OS */ }
  }, T);

  it('adds an endpoint, sets a key, tests with consent, disables and removes', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-provpage-')));
    const dir = path.join(root, '.reins');
    fake = await startFakeProvider();
    const host = new URL(fake.url).host;
    const shown = {
      reins: 1, id: 'shown', kind: 'provider', version: '1.0.0', label: 'Shown', protocol: 'openai-chat', untested: true, baseUrl: `${fake.url}/v1`,
      auth: { style: 'bearer', keyEnv: ['SHOWN_API_KEY'] }, defaultModel: 'sm', models: [{ id: 'sm', price: { input: 1, output: 2 } }],
    };
    fs.mkdirSync(path.join(dir, 'mods', 'shown'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mods', 'shown', 'mod.json'), JSON.stringify(shown, null, 2));
    mods = await startMods({ dir, env: {} });
    const redactor = new Redactor({ home: dir, env: {}, keyEnvNames: () => keyEnvNames(mods!) });
    store = openStore(':memory:');
    const s = store;
    srv = await startServer({
      store: s, dir, appDir: APP, mods, env: {}, redactor, probe: async () => PROBE,
      makeEngine: makeEngineFrom(mods, { env: {}, home: dir }, (id, origin) => s.hasConsent(id, origin)),
    });

    browser = await chromium.launch();
    const page: Page = await (await browser.newContext()).newPage();
    page.setDefaultTimeout(W);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    const rowOf = (id: string) => page.locator(`li.prow[data-id="${id}"]`);
    const bodyText = () => page.locator('body').innerText();
    const inputValues = async () => {
      const all = page.locator('input');
      return Promise.all([...Array(await all.count()).keys()].map((i) => all.nth(i).inputValue()));
    };

    // 1. the gear opens the page; the two fixed lines are on it
    await page.goto(srv.url);
    await page.getByRole('button', { name: 'Settings: Providers' }).click();
    const main = page.getByRole('main', { name: 'Providers' });
    await main.waitFor();
    await main.getByText(KEYS_LINE, { exact: true }).waitFor();
    await main.getByText(AGENTS_LINE, { exact: true }).waitFor();

    // 2. a manifest with `untested: true` shows the badge and the key-missing words; the built-in program provider has no key or test buttons
    const sh = rowOf('shown');
    await sh.waitFor();
    await sh.locator('.badge', { hasText: 'untested' }).waitFor();
    await sh.getByText('key missing: set SHOWN_API_KEY or add a key').waitFor();
    await sh.getByText(host).waitFor();
    const built = rowOf('claude-code');
    await built.waitFor();
    expect(await built.getByRole('button', { name: /key|Test connection/i }).count()).toBe(0);
    expect(await built.locator('.badge').count()).toBe(0);

    // 3. set a key on the manifest row: the field is empty afterwards and the page never shows the key
    await sh.getByRole('button', { name: 'Set key' }).click();
    await sh.getByLabel('Key for shown').fill(KEY2);
    await sh.getByRole('button', { name: 'Save key' }).click();
    await sh.getByText('key set').waitFor();
    await sh.getByLabel('Key for shown').waitFor({ state: 'detached' });
    await sh.getByRole('button', { name: 'Clear key' }).waitFor();
    expect(await bodyText()).not.toContain(KEY2);
    expect((await inputValues()).join('|')).not.toContain(KEY2);
    // opening the key field again starts empty: the saved key is not kept in the page
    await sh.getByRole('button', { name: 'Set key' }).click();
    expect(await sh.getByLabel('Key for shown').inputValue()).toBe('');
    await sh.getByRole('button', { name: 'Set key' }).click();
    await sh.getByLabel('Key for shown').waitFor({ state: 'detached' });

    // 4. add a custom endpoint through the form, with a key
    await main.getByRole('button', { name: 'Add custom endpoint' }).click();
    const form = page.getByRole('form', { name: 'Add custom endpoint' });
    await form.getByLabel('Label', { exact: true }).fill('Formed');
    await form.getByLabel('Id', { exact: true }).fill('formed');
    await form.getByRole('button', { name: 'Chat completions' }).click();
    await form.getByLabel('Base URL', { exact: true }).fill(`${fake.url}/v1`);
    await form.getByLabel('Environment variable name (instead of a key)').fill('FORMED_API_KEY');
    await form.getByLabel(/^Key \(saved to Reins/).fill(KEY);
    await form.getByLabel('Model id').fill('fake-model-1');
    await form.getByRole('button', { name: 'Add endpoint' }).click();
    const fm = rowOf('formed');
    await fm.waitFor();
    await fm.getByText('key set').waitFor();
    await form.waitFor({ state: 'detached' });
    expect(await bodyText()).not.toContain(KEY);
    expect((await inputValues()).join('|')).not.toContain(KEY);
    // the key went to the secrets file, never into the manifest
    expect(fs.readFileSync(path.join(dir, 'mods', 'formed', 'mod.json'), 'utf8')).not.toContain(KEY);
    expect(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')).toContain(KEY);

    // 5. Test connection asks first; Cancel sends nothing to the fake
    const before = fake.requests.length;
    await fm.getByRole('button', { name: 'Test connection' }).click();
    const dlg = fm.getByRole('dialog', { name: 'Allow sending' });
    await dlg.waitFor();
    await dlg.getByText(host).waitFor();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await dlg.waitFor({ state: 'detached' });
    await fm.getByText('Not tested. Nothing was sent.').waitFor();
    expect(fake.requests.length).toBe(before);

    // 6. Allow records the yes, then the 7.6 words appear in the row
    await fm.getByRole('button', { name: 'Test connection' }).click();
    await dlg.waitFor();
    await dlg.getByRole('button', { name: 'Allow' }).click();
    await fm.getByText(`Reached ${host}: 2 models.`).waitFor();
    expect(fake.listRequests().length).toBeGreaterThan(0);
    expect(fake.listRequests().every((r) => r.headers.authorization === `Bearer ${KEY}`)).toBe(true);

    // 7. Disable greys the row; Remove (after a confirm) removes it
    await fm.getByRole('button', { name: 'Disable' }).click();
    await page.locator('li.prow.dim[data-id="formed"]').waitFor();
    await fm.getByText('disabled', { exact: true }).waitFor();
    await fm.getByRole('button', { name: 'Remove', exact: true }).click();
    await fm.getByRole('button', { name: 'Remove formed' }).click();
    await fm.waitFor({ state: 'detached' });
    expect(fs.existsSync(path.join(dir, 'mods', 'formed'))).toBe(false);
    await sh.waitFor();

    expect(errors).toEqual([]);
  }, T);
});
