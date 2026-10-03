// The Phase 3c smoke test (plan 15e 3c.12): the built app in headless Chromium against a real server,
// with fake-claude behind the real claudeEngine and a fake folder picker.
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

const TURNS = { fixture: 'claude-2.1.281-turns.jsonl', turn: 0 };
const APPROVAL = 'claude-2.1.281-approval-allow-hold.jsonl';
const MARKER = 'claude-2.1.281-card-marker-hook.jsonl';
const T = 120_000;
const W = 15_000;

describe.skipIf(skip)('Phase 3c smoke test (spec 3c.12)', () => {
  it('the build has no inline script body (the CSP depends on it)', () => {
    const html = fs.readFileSync(INDEX, 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(s[1]).toBe('');
  });

  let browser: Browser | undefined;
  let srv: Server | undefined;
  let store: Store | undefined;
  afterAll(async () => {
    await browser?.close();
    await srv?.close();
    store?.close();
    await cleanup();
  }, T);

  it('drives the whole app in a browser', async () => {
    const fake = fakeSetup([TURNS, { fixture: APPROVAL, approve: true }, TURNS, { fixture: MARKER, delayMs: 150 }]);
    const folderA = fake.dir;
    const folderB = tmpDir();
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

    const box = page.getByRole('textbox', { name: 'Message' });
    const nameA = path.basename(folderA);
    const nameB = path.basename(folderB);
    const rail = page.getByRole('navigation', { name: 'Sessions' });
    const sendText = async (text: string) => { await box.fill(text); await box.press('Enter'); };
    const idle = () => page.locator('.chead .status.idle').waitFor();

    // 1. the token is gone from the address bar
    await page.goto(srv.url);
    await rail.waitFor();
    expect(page.url()).not.toContain('token');
    expect(page.url()).not.toContain(srv.token);

    // 2. Ctrl+O creates a session
    await page.keyboard.press('ControlOrMeta+O');
    await rail.getByText(nameA).waitFor();
    await rail.getByRole('button', { name: /New chat/ }).waitFor();
    await box.waitFor();
    const firstUrl = page.url();
    expect(firstUrl).toMatch(/#s=/);

    // 3. a plain message shows the agent's text
    await sendText('what does upload.mjs do?');
    await page.locator('.msg.agent', { hasText: 'ONE' }).waitFor();
    await idle();

    // 4. a tool question: Deny with a reason
    await sendText('change upload');
    const tool = page.getByRole('region', { name: 'tool question' });
    await tool.waitFor();
    await tool.getByRole('textbox').fill('no way');
    await tool.getByRole('button', { name: 'Deny' }).click();
    await page.getByText('answered: n no way').waitFor();
    const edit = page.locator('details.tool', { has: page.locator('summary b', { hasText: /^Edit$/ }) });
    await edit.locator('summary').click();
    await edit.locator('pre.result').getByText('The user said no: no way', { exact: false }).waitFor();
    await idle();

    // 5. #gate from the tag picker, then Approve; the receipt appears
    await box.fill('#ga');
    await page.getByRole('listbox', { name: 'Tags' }).getByRole('button', { name: /#gate/ }).waitFor();
    await box.press('Enter');
    await page.locator('.chip.tag', { hasText: '#gate' }).waitFor();
    await sendText('ship it');
    const gate = page.getByRole('region', { name: 'gate question' });
    await gate.waitFor();
    await gate.getByRole('button', { name: 'Approve' }).click();
    await page.getByRole('region', { name: /^Receipt for/ }).first().waitFor();
    await idle();

    // 6. a steer card typed while busy is delivered mid-turn
    const reads = page.locator('details.tool summary b', { hasText: /^Read$/ });
    const readsBefore = await reads.count();
    await sendText('read three files');
    await expect.poll(() => reads.count(), { timeout: W }).toBeGreaterThan(readsBefore);
    await sendText('End your answer with PINEAPPLE.');
    await page.getByText('card delivered (mid-turn)').waitFor();
    await idle();

    // 7. a second session in another folder, with its own log
    await page.keyboard.press('ControlOrMeta+O');
    await rail.getByText(nameB).waitFor();
    await expect.poll(() => page.url(), { timeout: W }).not.toBe(firstUrl);
    const log = page.locator('.log');
    expect(await log.getByText('what does upload.mjs do?').count()).toBe(0);
    await sendText('hello from b');
    await log.getByText('hello from b').waitFor();
    await log.locator('.msg.agent', { hasText: 'ONE' }).waitFor();
    await rail.locator(`section.group:has-text("${nameA}") button.item`).first().click();
    await log.getByText('what does upload.mjs do?').waitFor();
    expect(await log.getByText('hello from b').count()).toBe(0);

    // 8. the Text tab: new workflow, an error shows on its line, fixed, saved, Run, Trust, the run finishes
    const receipts = await page.getByRole('region', { name: /^Receipt for/ }).count();
    await page.getByRole('tab', { name: 'Text' }).click();
    await page.getByRole('textbox', { name: 'Workflow name' }).fill('smoke');
    await page.getByRole('button', { name: 'New workflow' }).click();
    const editor = page.getByRole('textbox', { name: 'Workflow text' });
    await editor.waitFor();
    const good = await editor.inputValue();
    expect(good).toContain('## phase build');
    const bad = good.replace('## phase build', '## bogus build');
    const badLine = bad.split('\n').findIndex((l) => l.startsWith('## bogus')) + 1;
    await editor.fill(bad);
    const diags = page.getByRole('list', { name: 'Diagnostics' });
    await diags.getByText(`line ${badLine}: Unknown step kind "bogus"`).first().waitFor();
    await editor.fill(good);
    await diags.getByText('No problems.').waitFor();
    await editor.fill(`${good}\n`);
    await editor.press('ControlOrMeta+S');
    await page.getByRole('status').getByText('Saved.').waitFor();
    await page.getByRole('button', { name: 'Run' }).click();
    const trust = page.getByRole('region', { name: 'trust question' });
    await trust.waitFor();
    expect(await trust.locator('.qdetail').innerText()).toBe('npm test');
    await trust.getByRole('button', { name: 'Trust', exact: true }).click();
    await expect.poll(() => page.getByRole('region', { name: /^Receipt for/ }).count(), { timeout: W }).toBeGreaterThan(receipts);
    await idle();

    // 8b. Run switched to Chat; the Text tab comes back with the file open and every step's state shown, and a reload restores tab, file and step
    const steps = page.locator('.receives li');
    const states = page.locator('.receives .sstate[aria-label]');
    await page.getByRole('tab', { name: 'Text' }).click();
    await page.locator('.ebar b', { hasText: 'smoke.reins.md' }).waitFor();
    await expect.poll(() => states.count(), { timeout: W }).toBe(await steps.count());
    for (let i = 0; i < await states.count(); i++) expect(await states.nth(i).getAttribute('aria-label')).toMatch(/^done/);
    await steps.nth(1).getByRole('button').click();
    await page.waitForTimeout(700); // the editor state is saved 500 ms after a change
    await page.reload();
    await rail.waitFor();
    await page.locator('.ebar b', { hasText: 'smoke.reins.md' }).waitFor();
    expect(await page.getByRole('tab', { name: 'Text' }).getAttribute('aria-selected')).toBe('true');
    await expect.poll(() => steps.nth(1).getByRole('button').getAttribute('aria-pressed'), { timeout: W }).toBe('true');

    // 8c.0. Canvas is a third tab on the same file; unsaved text survives Text <-> Canvas
    const canvasTab = page.getByRole('tab', { name: 'Canvas' });
    const textTab = page.getByRole('tab', { name: 'Text' });
    await canvasTab.click();
    expect(await canvasTab.getAttribute('aria-selected')).toBe('true');
    await page.locator('.ebar b', { hasText: 'smoke.reins.md' }).waitFor();
    await textTab.click();
    const clean = await editor.inputValue();
    await editor.fill(`${clean}x`);
    await canvasTab.click();
    await textTab.click();
    expect(await editor.inputValue()).toMatch(/x$/);
    await editor.fill(clean);

    // 8c.1. the canvas shows the boxes, with the finished run's state on them
    await canvasTab.click();
    const planNode = page.locator('.react-flow__node[data-id="plan"]');
    await planNode.waitFor();
    await page.locator('.react-flow__node[data-id="build"]').waitFor();
    await expect.poll(() => page.locator('.react-flow__node .sstate[aria-label^="done"]').count(), { timeout: W }).toBe(2);

    // 8c.2. draw a wire plan -> build
    const drag = async (from: string, to: string) => {
      const a = (await page.locator(from).boundingBox())!;
      const b = (await page.locator(to).boundingBox())!;
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
      await page.mouse.up();
    };
    await drag('[data-id="plan"] .react-flow__handle[data-handleid="next"]', '[data-id="build"] .react-flow__handle[data-handleid="in"]');
    await page.locator('[data-testid="rf__edge-plan>0>build"]').waitFor({ state: 'attached' });

    // 8c.3. the wire is `next:` in the Text tab, with no confirm (the file prints back as it is)
    await textTab.click();
    expect(await editor.inputValue()).toContain('## phase plan\nnext: build\n');

    // 8c.4. edit the Text: the wire moves
    const wired = await editor.inputValue();
    await editor.fill(`${wired.replace('next: build', 'next: ship')}\n## phase ship\n> Ship it.\n`);
    await diags.getByText('step `build` is never reached').first().waitFor();
    await canvasTab.click();
    await page.locator('[data-testid="rf__edge-plan>0>ship"]').waitFor({ state: 'attached' });
    expect(await page.locator('[data-testid="rf__edge-plan>0>build"]').count()).toBe(0);

    // 8c.5. Ctrl+S from inside the canvas saves
    await planNode.click();
    await page.keyboard.press('ControlOrMeta+S');
    await page.getByRole('status').getByText('Saved.').waitFor();

    // 8c.6. a dragged box keeps its place after a reload (flow coordinates, not screen)
    const transform = () => planNode.evaluate((e) => (e as unknown as { style: { transform: string } }).style.transform);
    const t0 = await transform();
    const pb = (await planNode.boundingBox())!;
    await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
    await page.mouse.down();
    await page.mouse.move(pb.x + pb.width / 2 + 120, pb.y + pb.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(700); // the editor state is saved 500 ms after a change
    const t1 = await transform();
    expect(t1).not.toBe(t0);
    await page.reload();
    await rail.waitFor();
    await planNode.waitFor();
    expect(await canvasTab.getAttribute('aria-selected')).toBe('true');
    expect(await transform()).toBe(t1);

    // 8c.7. the Block panel adds a `next` link to ship; Ctrl+S leaves the buffer clean
    await page.locator('[data-id="build"]').click();
    const panel = page.locator('aside[aria-label="Block panel"]');
    await panel.getByLabel('Link kind').selectOption('next');
    await panel.getByLabel('Link target').selectOption('ship');
    await panel.getByRole('button', { name: 'Add link' }).click();
    await textTab.click();
    await expect.poll(() => editor.inputValue(), { timeout: W }).toContain('## phase build\nnext: ship\n');
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+S');
    await page.getByRole('status').getByText('Saved.').waitFor();

    // 8d.0. Blocks is a fourth tab: the steps as a list, with the finished run's state on the rows
    const blocksTab = page.getByRole('tab', { name: 'Blocks' });
    const row = (id: string) => page.locator(`.blk[data-id="${id}"]`);
    await blocksTab.click();
    expect(await blocksTab.getAttribute('aria-selected')).toBe('true');
    await page.locator('.ebar b', { hasText: 'smoke.reins.md' }).waitFor();
    await row('ship').waitFor();
    expect(await page.locator('.blk').evaluateAll((els) => els.map((e) => (e as unknown as { dataset: { id: string } }).dataset.id))).toEqual(['plan', 'build', 'ship']);
    await expect.poll(() => page.locator('.blk .sstate[aria-label^="done"]').count(), { timeout: W }).toBe(2);
    await row('plan').locator('.bhead').first().click();
    await panel.locator('h3', { hasText: 'plan' }).waitFor();

    // 8d.1. the arrows move a block within its list; down undoes up
    await textTab.click();
    const tidy = await editor.inputValue();
    await blocksTab.click();
    await page.getByRole('button', { name: 'Move build up' }).click();
    await textTab.click();
    await expect.poll(async () => { const t = await editor.inputValue(); return t.indexOf('## phase build') < t.indexOf('## phase plan'); }, { timeout: W }).toBe(true);
    await blocksTab.click();
    await page.getByRole('button', { name: 'Move build down' }).click();
    await textTab.click();
    await expect.poll(() => editor.inputValue(), { timeout: W }).toBe(tidy);

    // 8d.2. the palette adds a step after the selection and selects it; Delete in the panel removes it, byte for byte
    await blocksTab.click();
    await page.getByRole('toolbar', { name: 'Add a step' }).getByRole('button', { name: 'phase', exact: true }).click();
    await row('phase-1').waitFor();
    await panel.locator('h3', { hasText: 'phase-1' }).waitFor();
    await panel.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(() => row('phase-1').count(), { timeout: W }).toBe(0);
    await textTab.click();
    await expect.poll(() => editor.inputValue(), { timeout: W }).toBe(tidy);

    // 8d.3. an Always rule that YAML would misread is printed quoted, and reads back as typed
    const always = page.getByRole('textbox', { name: 'Always' });
    // retried inside the poll: a preview reply landing between fill and blur resets the draft; setAlways gives the same result every time
    await expect.poll(async () => {
      await blocksTab.click();
      await always.fill('Never: touch prod');
      await always.blur();
      await textTab.click();
      return editor.inputValue();
    }, { timeout: W }).toContain('always:\n  - "Never: touch prod"\n');
    await blocksTab.click();
    await expect.poll(() => always.inputValue(), { timeout: W }).toBe('Never: touch prod');

    // 8d.4. dragging a block's grip onto a drop line moves it
    await blocksTab.click();
    await row('build').locator('.grip').first().dragTo(page.locator('[data-drop="/kids/0"]'));
    await expect.poll(() => page.locator('.blk').evaluateAll((els) => els.map((e) => (e as unknown as { dataset: { id: string } }).dataset.id)), { timeout: W }).toEqual(['build', 'plan', 'ship']);
    await textTab.click();
    await expect.poll(async () => { const t = await editor.inputValue(); return t.includes('## phase build') && t.indexOf('## phase build') < t.indexOf('## phase plan'); }, { timeout: W }).toBe(true);

    // 8d.5. a block dropped on a container's empty drop line goes inside it
    await blocksTab.click();
    await page.getByRole('toolbar', { name: 'Add a step' }).getByRole('button', { name: 'repeat', exact: true }).click();
    await row('repeat-1').waitFor();
    await page.getByRole('toolbar', { name: 'Add a step' }).getByRole('button', { name: 'run', exact: true }).click();
    await row('run-1').waitFor();
    await row('run-1').locator('.grip').first().dragTo(page.locator('[data-drop="repeat-1/kids/0"]'));
    await textTab.click();
    await expect.poll(() => editor.inputValue(), { timeout: W }).toContain('## repeat\nuntil: you approve\nmax: 3\n\n### run `npm test`\n');

    // 8d.z. save, so the buffer is clean before Chat (Playwright dismisses the leave confirm)
    await textTab.click();
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+S');
    await page.getByRole('button', { name: 'Save', exact: true }).and(page.locator(':disabled')).waitFor();

    await page.getByRole('tab', { name: 'Chat' }).click();
    await page.waitForTimeout(700);

    // 9. a reload brings the same session and its history back
    const before = page.url();
    await page.reload();
    await rail.waitFor();
    expect(page.url()).toBe(before);
    await log.getByText('what does upload.mjs do?').waitFor();
    await log.getByText('answered: n no way').waitFor();
    await log.getByText('card delivered (mid-turn)').waitFor();
    expect(page.url()).not.toContain('token');

    expect(errors).toEqual([]);
  }, T);
});
