// Milestone P, Task 29 phase C (S5): Settings > Providers has a second list, "Protocols and other mods", with status words and the actions that
// make sense. A code protocol imported without trust waits there as "needs trust"; Trust (after the code prompt) runs it once. Disabling a protocol
// that providers use asks first and names them. Headless Chromium against a real server and the real loader. No network, no real key.
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
import { PROBE } from './http-helpers.js';

const APP = fileURLToPath(new URL('../../app/dist/', import.meta.url));
const INDEX = path.join(APP, 'index.html');
const skip = !fs.existsSync(INDEX) && !process.env.CI;
const T = 120_000;
const W = 15_000;
const CODE_PROMPT = 'This mod runs its own code inside Reins, with your rights: it can read your files and your keys, and use the network. Reins cannot limit what it does. Trust it only if you trust its author.';

describe.skipIf(skip)('Protocols and other mods (phase C, S5)', () => {
  let browser: Browser | undefined;
  let srv: Server | undefined;
  let store: Store | undefined;
  let mods: Mods | undefined;
  let root = '';
  afterAll(async () => {
    await browser?.close();
    await srv?.close();
    store?.close();
    mods?.dispose();
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the OS */ }
  }, T);

  it('lists protocols, trusts a code protocol after the prompt (it runs once), and asks before disabling a protocol that providers use', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-p29c-b-')));
    const dir = path.join(root, '.reins');
    const marker = path.join(root, 'marker.log');
    const ran = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean) : []);
    fs.mkdirSync(path.join(dir, 'mods', 'shown'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mods', 'shown', 'mod.json'), JSON.stringify({
      reins: 1, id: 'shown', kind: 'provider', version: '1.0.0', label: 'Shown', protocol: 'openai-chat', baseUrl: 'https://shown.test/v1',
      auth: { style: 'none', keyEnv: [] }, defaultModel: 'sm', models: [{ id: 'sm', price: { input: 0, output: 0 } }],
    }));
    mods = await startMods({ dir, env: {} });
    const redactor = new Redactor({ home: dir, env: {}, keyEnvNames: () => keyEnvNames(mods!) });
    store = openStore(':memory:');
    const s = store;
    srv = await startServer({
      store: s, dir, appDir: APP, mods, env: {}, redactor, catalogDir: path.join(root, 'no-catalog'), probe: async () => PROBE,
      makeEngine: makeEngineFrom(mods, { env: {}, home: dir }, (id, origin) => s.hasConsent(id, origin)),
    });

    browser = await chromium.launch();
    const page: Page = await (await browser.newContext()).newPage();
    page.setDefaultTimeout(W);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(srv.url);
    await page.getByRole('button', { name: 'Settings: Providers' }).click();
    const main = page.getByRole('main', { name: 'Providers' });
    await main.waitFor();
    const others = main.getByRole('list', { name: 'Protocols and other mods' });
    await main.getByRole('heading', { name: 'Protocols and other mods' }).waitFor();
    const other = (id: string) => others.locator(`li.prow[data-id="${id}"]`);

    // 1. the bundled protocol is in the second list with its kind, source, status and the provider that uses it; no Remove, no Edit, no Trust
    const chat = other('openai-chat');
    await chat.waitFor();
    await chat.getByText('ready', { exact: true }).waitFor();
    await chat.getByText('protocol · bundled · used by Shown', { exact: true }).waitFor();
    expect(await chat.getByRole('button', { name: /^(Remove|Edit|Trust|Test connection)/ }).count()).toBe(0);
    expect(await main.getByRole('list', { name: 'Providers' }).locator('li.prow[data-id="openai-chat"]').count()).toBe(0);

    // 2. disabling it asks first and names the providers; Keep changes nothing; the confirm disables it
    await chat.getByRole('button', { name: 'Disable' }).click();
    const sure = chat.getByRole('alert');
    await sure.getByText('Providers that use it will stop working: Shown', { exact: false }).waitFor();
    await sure.getByRole('button', { name: 'Keep' }).click();
    await sure.waitFor({ state: 'detached' });
    await chat.getByText('ready', { exact: true }).waitFor();
    await chat.getByRole('button', { name: 'Disable' }).click();
    await sure.getByRole('button', { name: 'Disable openai-chat' }).click();
    await chat.getByText('disabled', { exact: true }).waitFor();
    await chat.getByRole('button', { name: 'Enable' }).click();
    await chat.getByText('ready', { exact: true }).waitFor();

    // 3. import a code protocol without trust: it shows in the second list as needs trust, and has not run
    const files = {
      'mod.json': JSON.stringify({ reins: 1, id: 'wirey', kind: 'protocol', version: '1.0.0', label: 'Wirey', main: 'index.js' }),
      'index.js': `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, 'ran\\n');\nexport default function activate() {}\n`,
    };
    await main.getByRole('button', { name: 'Import', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Import a mod file' });
    await panel.getByLabel('Mod file text').fill(JSON.stringify({ reinsMod: 1, files }));
    await panel.getByRole('button', { name: 'Preview' }).click();
    await panel.getByRole('button', { name: 'Import without running its code' }).click();
    const wirey = other('wirey');
    await wirey.getByText('needs trust', { exact: true }).waitFor();
    await wirey.getByText('protocol · user', { exact: true }).waitFor();
    expect(ran()).toEqual([]);

    // 4. Trust shows the code prompt first; Cancel runs nothing; the confirm trusts exactly these bytes and runs the code once
    await wirey.getByRole('button', { name: 'Trust', exact: true }).click();
    const dlg = wirey.getByRole('dialog', { name: 'Trust this code' });
    await dlg.getByText(CODE_PROMPT, { exact: true }).waitFor();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await dlg.waitFor({ state: 'detached' });
    expect(ran()).toEqual([]);
    await wirey.getByRole('button', { name: 'Trust', exact: true }).click();
    await dlg.getByRole('button', { name: 'Trust and run wirey' }).click();
    await wirey.getByText('ready', { exact: true }).waitFor();
    expect(await wirey.getByRole('button', { name: 'Trust', exact: true }).count()).toBe(0);
    expect(ran()).toEqual(['ran']);

    // 5. a user protocol can be exported and removed (with a confirm); the list forgets it
    await wirey.getByRole('button', { name: 'Export' }).waitFor();
    await wirey.getByRole('button', { name: 'Remove', exact: true }).click();
    await wirey.getByRole('alert').getByText('Remove Wirey?', { exact: false }).waitFor();
    await wirey.getByRole('button', { name: 'Remove wirey' }).click();
    await wirey.waitFor({ state: 'detached' });
    expect(fs.existsSync(path.join(dir, 'mods', 'wirey'))).toBe(false);
    expect(ran()).toEqual(['ran']);
    expect(errors).toEqual([]);
  }, T);
});
