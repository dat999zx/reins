// The live-run e2e: the built app in headless Chromium against a real server, fake-claude replaying recorded
// turns behind the real claudeEngine. Every assertion waits on a held state (a gate waiting), never on a timed turn.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { claudeEngine } from '../src/claude/engine.js';
import { startServer, type Server } from '../src/server.js';
import { openStore, type Store } from '../src/store.js';
import { FAKE_CLAUDE, fakeSetup } from './helpers.js';
import { PROBE, tmpDir, cleanup } from './http-helpers.js';

const APP = fileURLToPath(new URL('../../app/dist/', import.meta.url));
const INDEX = path.join(APP, 'index.html');
const skip = !fs.existsSync(INDEX) && !process.env.CI;

const T = 120_000;
const W = 15_000;
const P = { fixture: 'claude-2.1.281-turns.jsonl', turn: 0, delayMs: 60 };
const B = { fixture: 'claude-2.1.281-card-marker-hook.jsonl', delayMs: 60 };
const H = { fixture: 'claude-2.1.281-approval-allow-hold.jsonl', approve: true };

const LIVE = (cmd: string) => `---
reins: 1
name: live
budget: { turns: 40, minutes: 30, usd: 4.00 }
always: []
---

## phase plan
> Plan it.

## run \`${cmd}\`

## gate
until: you approve

## phase build
> Build it.

## gate
until: you approve
`;

// the receives list in file order
const ORDER = ['plan', 'run-1', 'gate-1', 'build', 'gate-2'];

describe.skipIf(skip)('live run e2e', () => {
  let browser: Browser | undefined;
  let srv: Server | undefined;
  let store: Store | undefined;
  afterAll(async () => {
    await browser?.close();
    await srv?.close();
    store?.close();
    await cleanup();
  }, T);

  it('watches a workflow run from every tab', async () => {
    const fake = fakeSetup([P, B, P, B, H, B, P, B, H, B]);
    const folderA = fake.dir;
    const folderB = tmpDir();
    fs.mkdirSync(path.join(folderA, '.reins', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(folderA, '.reins', 'workflows', 'live.reins.md'), LIVE('node --version'));
    const folders = [folderA, folderB];
    store = openStore(':memory:');
    srv = await startServer({
      store, dir: tmpDir(), appDir: APP,
      probe: async () => PROBE,
      pickFolder: async () => folders.shift() ?? null,
      makeEngine: ({ model, effort, onApprove, onLive }) =>
        claudeEngine({ bin: FAKE_CLAUDE, ...(model ? { model } : {}), ...(effort ? { effort } : {}), onApprove, onLive }),
    });
    browser = await chromium.launch();
    const page: Page = await (await browser.newContext()).newPage();
    page.setDefaultTimeout(W);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    const rail = page.getByRole('navigation', { name: 'Sessions' });
    const tab = (name: string) => page.getByRole('tab', { name });
    const card = (kind: string) => page.getByRole('region', { name: `${kind} question` });
    const textChip = (id: string, state: string) => page.locator('.receives li').nth(ORDER.indexOf(id)).locator(`.sstate[aria-label^="${state}"]`).first();
    const openLive = async () => {
      await tab('Text').click();
      await page.locator('.ebar b', { hasText: 'live.reins.md' }).waitFor();
    };

    // L0. Run from the Text tab: Chat comes up, the trust and gate questions, marks on the Text list, a reload, the second gate, the receipt
    await page.goto(srv.url);
    await rail.waitFor();
    await page.keyboard.press('ControlOrMeta+O');
    await rail.getByText(path.basename(folderA)).waitFor();
    await tab('Text').click();
    await page.locator('.wflist button', { has: page.locator('.sx-wfname', { hasText: /^live$/ }) }).click();
    await page.locator('.ebar b', { hasText: 'live.reins.md' }).waitFor();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await page.locator('[role="tab"][aria-selected="true"]', { hasText: 'Chat' }).waitFor();
    const trust = card('trust');
    await trust.waitFor();
    await trust.getByRole('button', { name: 'Trust', exact: true }).click();
    await card('gate').waitFor();

    await openLive();
    await textChip('plan', 'done').waitFor();
    await textChip('run-1', 'done').waitFor();
    await textChip('gate-1', 'waiting').waitFor();

    await page.reload();
    await rail.waitFor();
    if ((await tab('Text').getAttribute('aria-selected')) !== 'true') await tab('Text').click();
    await page.locator('.ebar b', { hasText: 'live.reins.md' }).waitFor();
    await textChip('plan', 'done').waitFor();
    await textChip('run-1', 'done').waitFor();
    await textChip('gate-1', 'waiting').waitFor();

    await tab('Chat').click();
    await card('gate').getByRole('button', { name: 'Approve' }).click();
    await tab('Text').click();
    await textChip('gate-2', 'waiting').waitFor();
    await tab('Chat').click();
    await card('gate').getByRole('button', { name: 'Approve' }).click();
    await page.getByRole('region', { name: 'Receipt for live' }).waitFor();
    await page.locator('.chead .status.idle').waitFor();

    expect(errors).toEqual([]);
  }, T);
});
