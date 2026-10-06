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

    // 8c.0. the tabs are Chat, Blocks, Text; unsaved text survives Text <-> Blocks
    expect(await page.getByRole('tab').allInnerTexts()).toEqual(['Chat', 'Blocks', 'Text']);
    const blocksTab = page.getByRole('tab', { name: 'Blocks' });
    const textTab = page.getByRole('tab', { name: 'Text' });
    const row = (id: string) => page.locator(`.blk[data-id="${id}"]`);
    // the first point on a 24 px grid where the pointer is over the bare surface: not a block, an arrow, the toolbar or a menu
    const empty = async () => {
      const p = await page.evaluate(`(() => {
        const v = document.querySelector('[aria-label="Workspace"]');
        const r = v.getBoundingClientRect();
        for (let y = r.top + 24; y < r.bottom - 24; y += 24) for (let x = r.left + 24; x < r.right - 24; x += 24) {
          const e = document.elementFromPoint(x, y);
          if (e === v || (e && e.classList.contains('sx-world'))) return { x, y };
        }
        return null;
      })()`) as { x: number; y: number } | null;
      expect(p, 'no empty surface in the workspace').not.toBeNull();
      return p!;
    };
    const zoomLabel = page.locator('.sx-zoom output');
    await blocksTab.click();
    expect(await blocksTab.getAttribute('aria-selected')).toBe('true');
    await page.locator('.ebar b', { hasText: 'smoke.reins.md' }).waitFor();
    await textTab.click();
    const clean = await editor.inputValue();
    await editor.fill(`${clean}x`);
    await blocksTab.click();
    await textTab.click();
    expect(await editor.inputValue()).toMatch(/x$/);
    await editor.fill(clean);

    // 8c.2. the inspector adds a `next` link to a new step ship; Ctrl+S in Blocks saves
    await textTab.click();
    await editor.fill(`${clean}\n## phase ship\n> Ship it.\n`);
    await blocksTab.click();
    await row('ship').waitFor();
    const panel = page.locator('aside[aria-label="Block panel"]');
    for (const id of ['plan', 'build']) {
      await row(id).locator('.sx-row').first().click();
      await panel.getByLabel('Link kind').selectOption('next');
      await panel.getByLabel('Link target').selectOption('ship');
      await panel.getByRole('button', { name: 'Add link' }).click();
      // an edit made while another is in flight is dropped, so wait for the link before the next one
      await panel.getByText('next → ship').waitFor();
    }
    await textTab.click();
    await expect.poll(() => editor.inputValue(), { timeout: W }).toContain('## phase plan\nnext: ship\n');
    expect(await editor.inputValue()).toContain('## phase build\nnext: ship\n');
    await blocksTab.click();
    // 8c.2a. both links are drawn as arrows
    await page.locator('[data-link="plan/0"][data-lk="next"]').waitFor({ state: 'attached', timeout: W });
    await page.locator('[data-link="build/0"]').waitFor({ state: 'attached', timeout: W });
    await row('plan').locator('.sx-row').first().click();
    await page.keyboard.press('ControlOrMeta+S');
    await page.getByRole('status').getByText('Saved.').waitFor();

    // 8c.4. the zoom toolbar: Reset zoom is 100 %, Zoom in is 125 %; a reload restores the Blocks tab and the zoom
    await page.getByRole('button', { name: 'Reset zoom' }).click();
    await expect.poll(() => zoomLabel.innerText(), { timeout: W }).toBe('100%');
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(() => zoomLabel.innerText(), { timeout: W }).toBe('125%');
    await page.waitForTimeout(700); // the editor state is saved 500 ms after a change
    await page.reload();
    await rail.waitFor();
    await expect.poll(() => blocksTab.getAttribute('aria-selected'), { timeout: W }).toBe('true');
    await expect.poll(() => zoomLabel.innerText(), { timeout: W }).toBe('125%');
    await page.getByRole('button', { name: 'Reset zoom' }).click();
    await expect.poll(() => zoomLabel.innerText(), { timeout: W }).toBe('100%');
    // 8d.0. Blocks: the steps as a list, with the finished run's state on the rows
    await blocksTab.click();
    expect(await blocksTab.getAttribute('aria-selected')).toBe('true');
    await page.locator('.ebar b', { hasText: 'smoke.reins.md' }).waitFor();
    await row('ship').waitFor();
    expect(await page.locator('.blk').evaluateAll((els) => els.map((e) => (e as unknown as { dataset: { id: string } }).dataset.id))).toEqual(['plan', 'build', 'ship']);
    await expect.poll(() => page.locator('.blk .sstate[aria-label^="done"]').count(), { timeout: W }).toBe(2);
    await expect.poll(() => page.locator('.sx-hat').innerText(), { timeout: W }).toContain('smoke');
    await row('plan').locator('.sx-row').first().click();
    await panel.locator('h3', { hasText: 'plan' }).waitFor();
    // a click on the bare surface clears the selection: the side column shows the Workflow panel with the Always box
    const bare = await empty();
    await page.mouse.click(bare.x, bare.y);
    await page.getByRole('complementary', { name: 'Workflow panel' }).getByRole('textbox', { name: 'Always' }).waitFor();

    // the text the next steps compare against byte for byte
    await textTab.click();
    const tidy = await editor.inputValue();

    // 8d.1. Alt+Up / Alt+Down move the focused block within its list, focus follows; all inside Blocks (Text would unmount the pane)
    await blocksTab.click();
    const order = () => page.locator('.blk').evaluateAll((els) => els.map((e) => (e as unknown as { dataset: { id: string } }).dataset.id));
    await row('build').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(order, { timeout: W }).toEqual(['build', 'plan', 'ship']);
    await expect.poll(() => page.locator(':focus').getAttribute('data-id', { timeout: 1000 }).catch(() => null), { timeout: W }).toBe('build');
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(order, { timeout: W }).toEqual(['plan', 'build', 'ship']);
    await textTab.click();
    await expect.poll(() => editor.inputValue(), { timeout: W }).toBe(tidy);

    // 8d.2. a palette card adds a step after the selection and selects it; the Delete key removes it, then the panel's Delete button, byte for byte
    const palette = page.getByRole('region', { name: 'Palette' });
    const card = (name: string) => palette.getByRole('button', { name, exact: true });
    await blocksTab.click();
    await card('phase').click();
    await row('phase-1').waitFor();
    await panel.locator('h3', { hasText: 'phase-1' }).waitFor();
    await row('phase-1').focus();
    await page.keyboard.press('Delete');
    await expect.poll(() => row('phase-1').count(), { timeout: W }).toBe(0);
    // undo brings the deleted block back, redo removes it again
    await page.getByRole('region', { name: 'Workspace' }).focus();
    await page.keyboard.press('ControlOrMeta+Z');
    await row('phase-1').waitFor({ timeout: W });
    await page.keyboard.press('ControlOrMeta+Shift+Z');
    await expect.poll(() => row('phase-1').count(), { timeout: W }).toBe(0);
    await textTab.click();
    await expect.poll(() => editor.inputValue(), { timeout: W }).toBe(tidy);
    await blocksTab.click();
    await card('phase').click();
    await row('phase-1').waitFor();
    await panel.locator('h3', { hasText: 'phase-1' }).waitFor();
    await panel.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(() => row('phase-1').count(), { timeout: W }).toBe(0);
    await textTab.click();
    await expect.poll(() => editor.inputValue(), { timeout: W }).toBe(tidy);

    // 8d.2b. Enter selects a focused block; Alt+Right nests a block into the C block before it, Alt+Left takes it out
    await blocksTab.click();
    await row('ship').focus();
    await page.keyboard.press('Enter');
    await panel.locator('h3', { hasText: 'ship' }).waitFor();
    await card('repeat until').click();
    await row('repeat-1').waitFor();
    await card('phase').click();
    await row('phase-1').waitFor();
    await row('phase-1').focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect.poll(() => row('repeat-1').locator('.blk[data-id="phase-1"]').count(), { timeout: W }).toBe(1);
    await textTab.click();
    await expect.poll(() => editor.inputValue(), { timeout: W }).toContain('## repeat\nuntil: you approve\nmax: 3\n\n### phase\n');
    await blocksTab.click();
    await row('phase-1').focus();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect.poll(() => row('repeat-1').locator('.blk[data-id="phase-1"]').count(), { timeout: W }).toBe(0);
    await row('phase-1').focus();
    await page.keyboard.press('Delete');
    await expect.poll(() => row('phase-1').count(), { timeout: W }).toBe(0);
    await row('repeat-1').focus();
    await page.keyboard.press('Delete');
    await expect.poll(() => row('repeat-1').count(), { timeout: W }).toBe(0);
    await textTab.click();
    await expect.poll(() => editor.inputValue(), { timeout: W }).toBe(tidy);

    // 8d.3. an Always rule that YAML would misread is printed quoted, and reads back as typed
    const always = page.getByRole('textbox', { name: 'Always' });
    // retried inside the poll: a preview reply landing between fill and blur resets the draft; setAlways gives the same result every time
    await expect.poll(async () => {
      await blocksTab.click();
      const spot = await empty(); // the Always box lives in the Workflow panel, shown when no block is selected
      await page.mouse.click(spot.x, spot.y);
      await always.fill('Never: touch prod');
      await always.blur();
      await textTab.click();
      return editor.inputValue();
    }, { timeout: W }).toContain('always:\n  - "Never: touch prod"\n');
    await blocksTab.click();
    await expect.poll(() => always.inputValue(), { timeout: W }).toBe('Never: touch prod');

    // 8d.4. a block's grip dragged onto the top half of another block moves it before that block
    await blocksTab.click();
    await row('build').locator('.sx-grip').first().dragTo(row('plan').locator('.sx-row').first(), { targetPosition: { x: 30, y: 3 } });
    await expect.poll(order, { timeout: W }).toEqual(['build', 'plan', 'ship']);
    await textTab.click();
    await expect.poll(async () => (await editor.inputValue()).split('\n').filter((l) => l.startsWith('## ')), { timeout: W })
      .toEqual(['## phase build', '## phase plan', '## phase ship']);

    // 8d.5. a value typed in a pill on the block lands in the file
    await blocksTab.click();
    await card('run command').click();
    await row('run-1').waitFor();
    const cmd = page.getByRole('textbox', { name: 'Command of run-1' });
    // retried inside the poll: the palette add selects run-1 and its preview can land after the first fill (the pill holds its draft only while focused)
    await expect.poll(async () => {
      await blocksTab.click();
      await cmd.fill('npm run lint');
      await cmd.press('Enter');
      await textTab.click();
      return editor.inputValue();
    }, { timeout: W }).toContain('## run `npm run lint`');
    // Escape reverts the draft and sends nothing
    await blocksTab.click();
    await cmd.focus();
    await cmd.fill('discard me');
    await cmd.press('Escape');
    expect(await cmd.inputValue()).toBe('npm run lint');
    await cmd.blur();
    await textTab.click();
    expect(await editor.inputValue()).not.toContain('discard me');

    // 8d.6. a condition picked on a hexagon, a number typed in its pill, and a Conditions card clicked, all land in the file
    await blocksTab.click();
    await card('repeat until').click();
    await row('repeat-1').waitFor();
    // retried inside the poll: an edit made while another is in flight is dropped
    await expect.poll(async () => {
      await blocksTab.click();
      await page.getByRole('combobox', { name: 'Condition of repeat-1', exact: true }).selectOption({ label: 'attempts > N' });
      await textTab.click();
      return editor.inputValue();
    }, { timeout: W }).toContain('## repeat\nuntil: attempts > 3\nmax: 3\n');
    const num = page.getByRole('textbox', { name: 'Value of repeat-1 condition', exact: true });
    await expect.poll(async () => {
      await blocksTab.click();
      await num.fill('5');
      await num.press('Enter');
      await textTab.click();
      return editor.inputValue();
    }, { timeout: W }).toContain('until: attempts > 5');
    await expect.poll(async () => {
      await blocksTab.click();
      await row('repeat-1').locator('.sx-row').first().click();
      await card('tests pass').click();
      await textTab.click();
      return editor.inputValue();
    }, { timeout: W }).toContain('## repeat\nuntil: tests pass\nmax: 3\n');

    // 8d.7. a grip dragged into an empty C body nests the block; a click on the nested block selects it, not the C block around it
    await blocksTab.click();
    await row('run-1').locator('.sx-grip').first().dragTo(page.locator('[data-body="repeat-1/kids"]'));
    await textTab.click();
    await expect.poll(() => editor.inputValue(), { timeout: W }).toContain('## repeat\nuntil: tests pass\nmax: 3\n\n### run `npm run lint`\n');
    await blocksTab.click();
    await row('run-1').locator('.sx-row').first().click();
    await panel.locator('h3', { hasText: 'run-1' }).waitFor();

    // 8d.8. a condition card dragged onto a hexagon replaces that condition (a different card than the one already there, so the drop must change the file)
    await blocksTab.click();
    await card('attempts > N').dragTo(page.locator('[data-hex="repeat-1/"]'));
    await textTab.click();
    await expect.poll(() => editor.inputValue(), { timeout: W }).toContain('## repeat\nuntil: attempts > 3\nmax: 3\n');

    // 8d.9. a step card dragged onto the hat goes first in the workflow
    await blocksTab.click();
    await card('phase').dragTo(page.locator('.sx-hat'));
    await textTab.click();
    await expect.poll(async () => (await editor.inputValue()).split('\n').find((l) => l.startsWith('## ')), { timeout: W }).toBe('## phase');

    // 8d.10. a palette card dropped into an empty repeat body, and into the else body that a fresh if does not have yet
    await blocksTab.click();
    await row('ship').locator('.sx-row').first().click();
    await card('repeat until').click();
    await row('repeat-2').waitFor();
    await card('if / else').click();
    await row('if-1').waitFor();
    await card('custom prompt').dragTo(page.locator('[data-body="repeat-2/kids"]'));
    // one edit at a time: wait for the first drop to land before the second
    await expect.poll(() => row('repeat-2').locator('.blk[data-id="say-1"]').count(), { timeout: W }).toBe(1);
    await card('phase').dragTo(page.locator('[data-body="if-1/else"]'));
    await expect.poll(() => row('if-1').locator('.blk[data-id="phase-2"]').count(), { timeout: W }).toBe(1);
    await textTab.click();
    await expect.poll(() => editor.inputValue(), { timeout: W }).toContain('## repeat\nid: repeat-2\nuntil: you approve\nmax: 3\n\n### say\n');
    expect(await editor.inputValue()).toContain('## if you approve\n\n### else\n\n### phase\n');

    // 8e.e. the end step: a palette card exists; an `## end` typed in Text shows as a block of that kind, not as "does not parse"
    await blocksTab.click();
    await card('end').waitFor({ timeout: W });
    await textTab.click();
    const beforeEnd = await editor.inputValue();
    await editor.fill(`${beforeEnd}\n## end\n`);
    await blocksTab.click();
    await row('end-1').waitFor({ timeout: W });
    expect(await row('end-1').getAttribute('data-kind')).toBe('end');
    expect(await page.getByText('This file does not parse').count()).toBe(0);
    await textTab.click();
    await editor.fill(beforeEnd);

    // 8e.0c. a plain drag on bare surface pans; the wheel zooms toward the cursor
    await blocksTab.click();
    const hatBox = async () => (await page.locator('.sx-hat').boundingBox())!;
    const hat0 = await hatBox();
    const from = await empty();
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 80, from.y + 40, { steps: 8 });
    await page.mouse.up();
    const hat1 = await hatBox();
    expect(Math.abs(hat1.x - hat0.x - 80)).toBeLessThanOrEqual(2);
    expect(Math.abs(hat1.y - hat0.y - 40)).toBeLessThanOrEqual(2);
    const mid = { x: hat1.x + hat1.width / 2, y: hat1.y + hat1.height / 2 };
    await page.mouse.move(mid.x, mid.y);
    await page.mouse.wheel(0, -240);
    await expect.poll(async () => parseInt(await zoomLabel.innerText(), 10), { timeout: W }).toBeGreaterThan(100);
    const hat2 = await hatBox();
    expect(Math.abs(hat2.x + hat2.width / 2 - mid.x)).toBeLessThanOrEqual(3);
    expect(Math.abs(hat2.y + hat2.height / 2 - mid.y)).toBeLessThanOrEqual(3);
    await page.getByRole('button', { name: 'Reset zoom' }).click();
    await expect.poll(() => zoomLabel.innerText(), { timeout: W }).toBe('100%');

    // 8e.0. one pointer engine: nothing is natively draggable; the hat moves the whole script, and the file is untouched
    await blocksTab.click();
    expect(await page.locator('.texttab [draggable="true"]').count()).toBe(0);
    const drag = async (a: { x: number; y: number }, b: { x: number; y: number }) => {
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 8 });
      await page.mouse.up();
    };
    const hat3 = await hatBox();
    await textTab.click();
    const textBeforeHat = await editor.inputValue();
    await blocksTab.click();
    await drag({ x: hat3.x + hat3.width / 2, y: hat3.y + hat3.height / 2 }, { x: hat3.x + hat3.width / 2 + 120, y: hat3.y + hat3.height / 2 + 60 });
    const hat4 = await hatBox();
    expect(Math.abs(hat4.x - hat3.x - 120)).toBeLessThanOrEqual(2);
    expect(Math.abs(hat4.y - hat3.y - 60)).toBeLessThanOrEqual(2);
    // 8e.0b. undo puts the script back
    await page.getByRole('region', { name: 'Workspace' }).focus();
    await page.keyboard.press('ControlOrMeta+Z');
    await expect.poll(async () => { const h = await hatBox(); return Math.abs(h.x - hat3.x) <= 2 && Math.abs(h.y - hat3.y) <= 2; }, { timeout: W }).toBe(true);
    await textTab.click();
    expect(await editor.inputValue()).toBe(textBeforeHat);
    // 8e.1. Shift+click selects several; Delete removes them in one edit, one Ctrl+Z brings them back; a Shift+drag box selects; a multi-drag moves them together
    await blocksTab.click();
    const workspace = page.getByRole('region', { name: 'Workspace' });
    const selected = page.locator('.blk.sx-sel');
    await row('plan').locator('.sx-row').first().click();
    await row('build').locator('.sx-row').first().click({ modifiers: ['Shift'] });
    await expect.poll(() => selected.count(), { timeout: W }).toBe(2);
    await page.keyboard.press('Delete');
    await expect.poll(async () => (await row('plan').count()) + (await row('build').count()), { timeout: W }).toBe(0);
    await textTab.click();
    expect(await editor.inputValue()).not.toMatch(/## phase (plan|build)\n/);
    await blocksTab.click();
    await workspace.focus();
    await page.keyboard.press('ControlOrMeta+Z');
    await row('build').waitFor({ timeout: W });
    await textTab.click();
    expect(await editor.inputValue()).toBe(textBeforeHat);
    await blocksTab.click();
    await workspace.focus();
    await page.keyboard.press('Escape');
    await expect.poll(() => selected.count(), { timeout: W }).toBe(0);
    // build sits above plan here (8c.2 swapped them)
    const upper = (await row('build').boundingBox())!, lower = (await row('plan').boundingBox())!;
    await page.keyboard.down('Shift');
    await drag({ x: upper.x - 20, y: upper.y - 6 }, { x: lower.x + lower.width + 20, y: lower.y + lower.height + 6 });
    await page.keyboard.up('Shift');
    await expect.poll(() => selected.count(), { timeout: W }).toBe(2);
    expect(await row('plan').getAttribute('class')).toContain('sx-sel');
    expect(await row('build').getAttribute('class')).toContain('sx-sel');
    // dragging one selected block takes the whole selection
    const base = await order();
    const grab = (await row('plan').locator('.sx-grip').first().boundingBox())!, shipBox = (await row('ship').boundingBox())!;
    await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
    await page.mouse.down();
    await page.mouse.move(shipBox.x + 40, shipBox.y + shipBox.height * 0.7, { steps: 8 });
    await page.mouse.up();
    const moved = base.filter((id) => id !== 'build' && id !== 'plan');
    moved.splice(moved.indexOf('ship') + 1, 0, 'build', 'plan');
    await expect.poll(order, { timeout: W }).toEqual(moved);
    await workspace.focus();
    await page.keyboard.press('ControlOrMeta+Z');
    await expect.poll(order, { timeout: W }).toEqual(base);
    await textTab.click();
    expect(await editor.inputValue()).toBe(textBeforeHat);
    await blocksTab.click();
    await workspace.focus();
    await page.keyboard.press('Escape');
    // 8e.2a. a palette card dropped on bare surface is a loose block: not in the file; click it and Delete removes it
    await blocksTab.click();
    const looseBlocks = page.locator('.sx-loose');
    const cardBox = (await card('phase').boundingBox())!;
    await drag({ x: cardBox.x + cardBox.width / 2, y: cardBox.y + cardBox.height / 2 }, await empty());
    await expect.poll(() => looseBlocks.count(), { timeout: W }).toBe(1);
    await textTab.click();
    expect(await editor.inputValue()).toBe(textBeforeHat);
    await blocksTab.click();
    await looseBlocks.locator('.sx-row').first().click();
    await page.keyboard.press('Delete');
    await expect.poll(() => looseBlocks.count(), { timeout: W }).toBe(0);
    // 8e.3. Ctrl+C then Ctrl+V pastes a loose copy at the pointer; Ctrl+D puts a copy right after the original; Ctrl+Z takes it back
    await row('plan').locator('.sx-row').first().click();
    await page.keyboard.press('ControlOrMeta+C');
    const spot = await empty();
    await page.mouse.move(spot.x, spot.y);
    await page.keyboard.press('ControlOrMeta+V');
    await expect.poll(() => looseBlocks.count(), { timeout: W }).toBe(1);
    await looseBlocks.locator('.sx-row').first().click();
    await page.keyboard.press('Delete');
    await expect.poll(() => looseBlocks.count(), { timeout: W }).toBe(0);
    await row('plan').locator('.sx-row').first().click();
    await page.keyboard.press('ControlOrMeta+D');
    await textTab.click();
    await expect.poll(async () => ((await editor.inputValue()).match(/## phase plan/g) ?? []).length, { timeout: W }).toBe(2);
    await blocksTab.click();
    await workspace.focus();
    await page.keyboard.press('ControlOrMeta+Z');
    await textTab.click();
    await expect.poll(() => editor.inputValue(), { timeout: W }).toBe(textBeforeHat);
    await blocksTab.click();
    await workspace.focus();
    await page.keyboard.press('Escape');
    // 8e.2. dragging a step onto bare surface parks it (it leaves the file, the links into it go); dragging the loose block onto a slot puts it back; each is one undo step
    const park = async () => {
      await page.getByRole('button', { name: 'Fit' }).click();
      await page.waitForTimeout(600); // the 300 ms preview debounce: an edit while the preview is stale is refused
      const g = (await row('ship').locator('.sx-grip').first().boundingBox())!;
      await drag({ x: g.x + g.width / 2, y: g.y + g.height / 2 }, await empty());
      await expect.poll(() => looseBlocks.count(), { timeout: W }).toBe(1);
    };
    await park();
    await page.getByText(/Removed 2 links/).waitFor({ timeout: W });
    await textTab.click();
    const parkedText = await editor.inputValue();
    expect(parkedText).not.toContain('## phase ship');
    expect(parkedText).not.toContain('next: ship');
    await blocksTab.click();
    await workspace.focus();
    await page.keyboard.press('ControlOrMeta+Z');
    await expect.poll(() => looseBlocks.count(), { timeout: W }).toBe(0);
    await textTab.click();
    expect(await editor.inputValue()).toBe(textBeforeHat);
    await blocksTab.click();
    await park();
    const lg = (await looseBlocks.locator('.sx-grip').first().boundingBox())!, planBox = (await row('plan').boundingBox())!;
    await drag({ x: lg.x + lg.width / 2, y: lg.y + lg.height / 2 }, { x: planBox.x + 40, y: planBox.y + 4 });
    await expect.poll(() => looseBlocks.count(), { timeout: W }).toBe(0);
    await textTab.click();
    expect((await editor.inputValue()).split('\n').filter((l) => l.startsWith('## phase '))).toEqual(['## phase build', '## phase ship', '## phase plan']);
    await blocksTab.click();
    await workspace.focus();
    await page.keyboard.press('ControlOrMeta+Z');
    await expect.poll(() => looseBlocks.count(), { timeout: W }).toBe(1);
    await page.keyboard.press('ControlOrMeta+Z');
    await expect.poll(() => looseBlocks.count(), { timeout: W }).toBe(0);
    await textTab.click();
    expect(await editor.inputValue()).toBe(textBeforeHat);
    await blocksTab.click();
    await workspace.focus();
    await page.keyboard.press('Escape');
    // 8e.4. right-click and keyboard menus: block, loose block, bare surface
    const menu = page.getByRole('menu');
    const buildCount = async () => ((await editor.inputValue()).match(/## phase build/g) ?? []).length;
    await page.waitForTimeout(600); // the 300 ms preview debounce: an edit while the preview is stale is refused
    const rb = (await row('build').locator('.sx-row').first().boundingBox())!;
    await page.mouse.click(rb.x + rb.width / 2, rb.y + rb.height / 2, { button: 'right' });
    await menu.waitFor({ timeout: W });
    await menu.getByRole('menuitem', { name: 'Duplicate' }).click();
    await textTab.click();
    await expect.poll(buildCount, { timeout: W }).toBe(2);
    await blocksTab.click();
    await workspace.focus();
    await page.keyboard.press('ControlOrMeta+Z');
    await textTab.click();
    await expect.poll(buildCount, { timeout: W }).toBe(1);
    await blocksTab.click();
    await row('plan').focus();
    await page.keyboard.press('Shift+F10');
    await menu.waitFor({ timeout: W });
    expect(await page.evaluate('document.activeElement && document.activeElement.textContent')).toContain('Duplicate');
    expect(await page.evaluate('document.activeElement && document.activeElement.getAttribute("role")')).toBe('menuitem');
    await page.keyboard.press('Escape');
    await expect.poll(() => menu.count(), { timeout: W }).toBe(0);
    expect(await page.evaluate('document.activeElement && document.activeElement.dataset.id')).toBe('plan');
    await row('plan').locator('.sx-row').first().click();
    await page.keyboard.press('ControlOrMeta+C');
    const spot4 = await empty();
    await page.mouse.move(spot4.x, spot4.y);
    await page.keyboard.press('ControlOrMeta+V');
    await expect.poll(() => looseBlocks.count(), { timeout: W }).toBe(1);
    const lb = (await looseBlocks.locator('.sx-row').first().boundingBox())!;
    await page.mouse.click(lb.x + lb.width / 2, lb.y + lb.height / 2, { button: 'right' });
    await menu.getByRole('menuitem', { name: 'Delete' }).click();
    await expect.poll(() => looseBlocks.count(), { timeout: W }).toBe(0);
    const spot5 = await empty();
    await page.mouse.click(spot5.x, spot5.y, { button: 'right' });
    await menu.getByRole('menuitem', { name: 'Select all' }).click();
    await expect.poll(() => selected.count(), { timeout: W }).toBeGreaterThanOrEqual(3);
    await workspace.focus();
    await page.keyboard.press('Escape');
    await expect.poll(() => selected.count(), { timeout: W }).toBe(0);
    // 8e.5. draw a link from a handle (backward, so it gets max 3); delete it from its menu; draw it again; select the arrow and press Delete
    const centre = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    const arrow = page.locator('[data-link="ship/0"]');
    // the middle of the arrow's path, in client pixels
    const arrowAt = async () => (await page.evaluate(`(() => {
      const p = document.querySelector('[data-link="ship/0"] .sx-hit'), q = p.getPointAtLength(p.getTotalLength() / 2), m = p.getScreenCTM();
      return { x: m.a * q.x + m.c * q.y + m.e, y: m.b * q.x + m.d * q.y + m.f };
    })()`)) as { x: number; y: number };
    const draw = async () => {
      await page.waitForTimeout(600); // the 300 ms preview debounce: an edit while the preview is stale is refused
      await row('ship').locator('.sx-row').first().hover();
      const hb = (await row('ship').locator('.sx-handle[data-lk="next"]').boundingBox())!;
      await drag(centre(hb), centre((await row('plan').locator('.sx-row').first().boundingBox())!));
      await arrow.waitFor({ state: 'attached', timeout: W });
    };
    await draw();
    await textTab.click();
    expect(await editor.inputValue()).toContain('## phase ship\nnext: plan (max 3)\n');
    await blocksTab.click();
    const at1 = await arrowAt();
    await page.mouse.click(at1.x, at1.y, { button: 'right' });
    await menu.getByRole('menuitem', { name: 'Delete link' }).click();
    await expect.poll(() => arrow.count(), { timeout: W }).toBe(0);
    await textTab.click();
    expect(await editor.inputValue()).toBe(textBeforeHat);
    await blocksTab.click();
    await draw();
    const at2 = await arrowAt();
    await page.mouse.click(at2.x, at2.y);
    await page.keyboard.press('Delete');
    await expect.poll(() => arrow.count(), { timeout: W }).toBe(0);
    await textTab.click();
    expect(await editor.inputValue()).toBe(textBeforeHat);
    await blocksTab.click();
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
