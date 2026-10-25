// Milestone P, Task 24 (spec 7.3, 7.7): the first-run chooser, Skip, and the import dialog with its trust prompts, in headless Chromium against a
// real server, the real loader and a fake provider server. The catalog is the fixture folder (`fixtures/catalog`), copied with the fake's port.
// No network, no real key.
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
const FIXTURES = fileURLToPath(new URL('./fixtures/catalog/', import.meta.url));
const INDEX = path.join(APP, 'index.html');
const skip = !fs.existsSync(INDEX) && !process.env.CI;
const T = 180_000;
const W = 15_000;
const BUILT_IN_LINE = 'Claude Code is built in and ready if it is installed.';
// Spec 7.7, word for word.
const CODE_PROMPT = 'This mod runs its own code inside Reins, with your rights: it can read your files and your keys, and use the network. Reins cannot limit what it does. Trust it only if you trust its author.';

describe.skipIf(skip)('first run and import (spec 7.3, 7.7)', () => {
  const opened: Array<() => Promise<unknown> | unknown> = [];
  afterAll(async () => {
    for (const f of opened.splice(0).reverse()) { try { await f(); } catch { /* closing */ } }
  }, T);

  let browser: Browser | undefined;
  let fake: Awaited<ReturnType<typeof startFakeProvider>> | undefined;
  const need = async () => {
    fake ??= await startFakeProvider();
    if (!browser) {
      browser = await chromium.launch();
      opened.push(() => browser?.close(), () => fake?.close());
    }
    return { browser, fake };
  };

  /** A server on a fresh home with the fixture catalog (plus a `claude-code` entry that must never be offered). */
  async function world(o: { done?: boolean } = {}) {
    const { browser, fake } = await need();
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-firstrun-b-')));
    const dir = path.join(root, '.reins');
    const catalogDir = path.join(root, 'catalog');
    fs.mkdirSync(dir, { recursive: true });
    if (o.done) fs.writeFileSync(path.join(dir, 'first-run-done'), '');
    const port = new URL(fake.url).port;
    for (const id of ['alpha', 'beta']) {
      fs.mkdirSync(path.join(catalogDir, id), { recursive: true });
      fs.writeFileSync(path.join(catalogDir, id, 'mod.json'), fs.readFileSync(path.join(FIXTURES, id, 'mod.json'), 'utf8').replaceAll('__PORT__', port));
    }
    fs.mkdirSync(path.join(catalogDir, 'claude-code'));
    fs.writeFileSync(path.join(catalogDir, 'claude-code', 'mod.json'), fs.readFileSync(path.join(catalogDir, 'alpha', 'mod.json'), 'utf8').replace('"alpha"', '"claude-code"'));
    const mods: Mods = await startMods({ dir, env: {} });
    const redactor = new Redactor({ home: dir, env: {}, keyEnvNames: () => keyEnvNames(mods) });
    const store: Store = openStore(':memory:');
    const srv: Server = await startServer({
      store, dir, appDir: APP, mods, env: {}, redactor, catalogDir, probe: async () => PROBE,
      makeEngine: makeEngineFrom(mods, { env: {}, home: dir }, (id, origin) => store.hasConsent(id, origin)),
    });
    opened.push(async () => {
      await srv.close();
      store.close();
      mods.dispose();
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the OS */ }
    });
    const page: Page = await (await browser.newContext({ acceptDownloads: true })).newPage();
    page.setDefaultTimeout(W);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    return { root, dir, srv, page, errors, fake };
  }

  it('shows the fixture catalog on first start, ticks the local one, installs the ticked ones, and does not ask again', async () => {
    const w = await world();
    const { page } = w;
    await page.goto(w.srv.url);
    const first = page.getByRole('main', { name: 'First run' });
    await first.getByRole('heading', { name: 'Choose your providers' }).waitFor();
    await first.getByText(BUILT_IN_LINE, { exact: true }).waitFor();
    // both fixture cards, and no card for claude-code
    const cards = first.locator('li.card');
    await cards.first().waitFor();
    expect(await Promise.all([0, 1].map((i) => cards.nth(i).getAttribute('data-id')))).toEqual(['alpha', 'beta']);
    expect(await cards.count()).toBe(2);
    expect(await first.locator('li[data-id="claude-code"]').count()).toBe(0);
    // each card says its host, what it needs, and the untested badge
    const alpha = first.locator('li[data-id="alpha"]');
    const beta = first.locator('li[data-id="beta"]');
    await alpha.getByText(`127.0.0.1:${new URL(w.fake.url).port} · needs no key`).waitFor();
    await beta.getByText(`127.0.0.1:${new URL(w.fake.url).port} · needs BETA_API_KEY`).waitFor();
    await alpha.locator('.badge', { hasText: 'untested' }).waitFor();
    await beta.locator('.badge', { hasText: 'untested' }).waitFor();
    // the local program answered the probe: ticked. The one with a key: not.
    expect(await alpha.getByRole('checkbox').isChecked()).toBe(true);
    expect(await beta.getByRole('checkbox').isChecked()).toBe(false);
    // the probe was one plain GET of the model list, with no key
    expect(w.fake.listRequests().length).toBeGreaterThan(0);
    expect(w.fake.requests.every((r) => r.path === '/v1/models' && !r.headers.authorization && !r.headers.cookie)).toBe(true);

    await beta.getByRole('checkbox').check();
    await first.getByRole('button', { name: 'Install' }).click();
    await first.waitFor({ state: 'detached' });
    expect(fs.readdirSync(path.join(w.dir, 'mods')).sort()).toEqual(['alpha', 'beta']);
    expect(fs.existsSync(path.join(w.dir, 'first-run-done'))).toBe(true);

    await page.getByRole('button', { name: 'Settings: Providers' }).click();
    const main = page.getByRole('main', { name: 'Providers' });
    await main.locator('li.prow[data-id="alpha"]').waitFor();
    await main.locator('li.prow[data-id="beta"]').getByText('key missing: set BETA_API_KEY or add a key').waitFor();

    // a second visit shows no chooser
    await page.reload();
    await page.getByRole('button', { name: 'Settings: Providers' }).waitFor();
    expect(await page.getByRole('main', { name: 'First run' }).count()).toBe(0);
    expect(w.errors).toEqual([]);
  }, T);

  it('Skip leaves the app, creates the mods folder empty, and the chooser never comes back', async () => {
    const w = await world();
    const { page } = w;
    await page.goto(w.srv.url);
    const first = page.getByRole('main', { name: 'First run' });
    await first.getByRole('button', { name: 'Skip' }).click();
    await first.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Settings: Providers' }).waitFor();
    expect(fs.readdirSync(path.join(w.dir, 'mods'))).toEqual([]);
    expect(fs.existsSync(path.join(w.dir, 'first-run-done'))).toBe(true);
    await page.reload();
    await page.getByRole('button', { name: 'Settings: Providers' }).waitFor();
    expect(await page.getByRole('main', { name: 'First run' }).count()).toBe(0);
    expect(w.errors).toEqual([]);
  }, T);

  it('import: the summary as text, the code prompt with its two choices, the built-in confirm, a refusal, and export', async () => {
    const w = await world({ done: true });
    const { page, root } = w;
    const base = `${w.fake.url}/v1`;
    const marker = path.join(root, 'marker.log');
    const prov = (id: string, over: Record<string, unknown> = {}) => ({
      reins: 1, id, kind: 'provider', version: '1.0.0', label: id, protocol: 'openai-chat', baseUrl: base, auth: { style: 'none', keyEnv: [] },
      defaultModel: 'm', models: [{ id: 'm', label: 'M', price: { input: 0, output: 0 } }], price: { input: 0, output: 0 }, ...over,
    });
    const asFile = (files: Record<string, string>) => JSON.stringify({ reinsMod: 1, files });
    const codeFile = asFile({
      'mod.json': JSON.stringify(prov('codey', { label: 'Codey', main: 'index.js' })),
      'index.js': `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, 'ran\\n');\nexport default function activate() {}\n`,
    });
    const ran = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean) : []);

    await page.goto(w.srv.url);
    await page.getByRole('button', { name: 'Settings: Providers' }).click();
    const main = page.getByRole('main', { name: 'Providers' });
    await main.waitFor();
    const panel = page.getByRole('region', { name: 'Import a mod file' });
    const paste = async (text: string) => {
      await panel.getByLabel('Mod file text').fill(text);
      await panel.getByRole('button', { name: 'Preview' }).click();
    };
    const rowOf = (id: string) => main.locator(`li.prow[data-id="${id}"]`);

    // 1. a mod with code: the summary, then the second prompt (the server's words) and two choices; "without code" leaves it untrusted
    await main.getByRole('button', { name: 'Import', exact: true }).click();
    await paste(codeFile);
    const lines = panel.getByRole('list', { name: 'What importing does' });
    await lines.getByText('Id: codey', { exact: true }).waitFor();
    await lines.getByText('Label: Codey', { exact: true }).waitFor();
    await lines.getByText('Kind: provider', { exact: true }).waitFor();
    await lines.getByText('Protocol: openai-chat', { exact: true }).waitFor();
    await lines.getByText('Has code: it runs inside Reins.', { exact: true }).waitFor();
    await lines.getByText(/^Files: index\.js \(\d+ bytes\), mod\.json \(\d+ bytes\)$/).waitFor();
    await panel.getByText(CODE_PROMPT, { exact: true }).waitFor();
    expect(await panel.getByRole('button', { name: 'Import', exact: true }).count()).toBe(0);
    await panel.getByRole('button', { name: 'Import without running its code' }).click();
    await rowOf('codey').getByText('needs trust', { exact: true }).waitFor();
    await main.getByText('Imported codey.').waitFor();
    expect(ran()).toEqual([]);

    // 2. the same file again: it says it replaces the user's copy; "Trust and import" runs the code, once
    await main.getByRole('button', { name: 'Import', exact: true }).click();
    await paste(codeFile);
    await lines.getByText('replaces your codey', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Trust and import' }).click();
    await rowOf('codey').getByText('ready', { exact: true }).waitFor();
    expect(ran()).toEqual(['ran']);

    // 3. export: the download is named after the id
    const [dl] = await Promise.all([page.waitForEvent('download'), rowOf('codey').getByRole('button', { name: 'Export' }).click()]);
    expect(dl.suggestedFilename()).toBe('codey.reins-mod.json');
    const exported = JSON.parse(fs.readFileSync((await dl.path())!, 'utf8'));
    expect(Object.keys(exported.files).sort()).toEqual(['index.js', 'mod.json']);

    // 4. a built-in replacement asks first; "Keep" writes nothing, the confirm writes it
    await main.getByRole('button', { name: 'Import', exact: true }).click();
    await paste(asFile({ 'mod.json': JSON.stringify(prov('claude-code', { label: 'Mine' })) }));
    await lines.getByText('replaces the built-in claude-code', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Import', exact: true }).click();
    const ask = panel.getByRole('dialog', { name: 'Replace the built-in provider' });
    await ask.waitFor();
    expect(fs.existsSync(path.join(w.dir, 'mods', 'claude-code'))).toBe(false);
    await ask.getByRole('button', { name: 'Keep the built-in' }).click();
    await ask.waitFor({ state: 'detached' });
    expect(fs.existsSync(path.join(w.dir, 'mods', 'claude-code'))).toBe(false);
    await panel.getByRole('button', { name: 'Import', exact: true }).click();
    await ask.getByRole('button', { name: 'Replace the built-in claude-code' }).click();
    await rowOf('claude-code').getByText('replaces the built-in claude-code').waitFor();
    expect(fs.existsSync(path.join(w.dir, 'mods', 'claude-code', 'mod.json'))).toBe(true);

    // 5. a refusal shows in place and Import stays off
    await main.getByRole('button', { name: 'Import', exact: true }).click();
    await paste(asFile({ 'mod.json': JSON.stringify(prov('evil')), '../x': 'nope' }));
    await panel.getByRole('alert').filter({ hasText: /a file name must not hold/ }).waitFor();
    expect(await panel.getByRole('button', { name: 'Import', exact: true }).isDisabled()).toBe(true);
    expect(fs.existsSync(path.join(w.dir, 'mods', 'evil'))).toBe(false);
    await panel.getByRole('button', { name: 'Cancel' }).click();

    // 6. text with markup characters is shown as text, from a picked file
    const label = '<b>bold</b> & <i>x</i>';
    await main.getByRole('button', { name: 'Import', exact: true }).click();
    await panel.locator('input[type=file]').setInputFiles({ name: 'plainy.json', mimeType: 'application/json', buffer: Buffer.from(asFile({ 'mod.json': JSON.stringify(prov('plainy', { label })) })) });
    await lines.getByText(`Label: ${label}`, { exact: true }).waitFor();
    expect(await lines.locator('b, i').count()).toBe(0);
    await panel.getByRole('button', { name: 'Import', exact: true }).click();
    await rowOf('plainy').getByText(label, { exact: true }).waitFor();
    expect(await rowOf('plainy').locator('b b, b i').count()).toBe(0);
    // the one console line is the browser's note on the refused file of step 5
    expect(w.errors).toEqual(['Failed to load resource: the server responded with a status of 400 (Bad Request)']);
  }, T);
});
