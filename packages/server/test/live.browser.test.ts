// The live-run e2e: the built app in headless Chromium against a real server, fake-claude replaying recorded
// turns behind the real claudeEngine. Every assertion waits on a held state (a gate waiting), never on a timed turn.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
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
    // held at gate-1: its knot holds the open question, so it is forced open and its toggle says why it does nothing
    const gate1 = page.getByRole('region', { name: 'Run log' }).getByRole('button', { name: /^Step wait until \(gate-1\)/ });
    expect(await gate1.getAttribute('aria-disabled')).toBe('true');
    await gate1.click({ force: true });
    expect(await gate1.getAttribute('aria-expanded')).toBe('true');
    await card('gate').waitFor();
    await card('gate').getByRole('button', { name: 'Approve' }).click();
    await tab('Text').click();
    await textChip('gate-2', 'waiting').waitFor();
    await tab('Chat').click();
    await card('gate').getByRole('button', { name: 'Approve' }).click();
    await page.getByRole('region', { name: 'Receipt for live' }).waitFor();
    await page.locator('.chead .status.idle').waitFor();

    // L1. The Reins feed: a region of knots, collapsed when done; names are unique; Blocks ↗ and Show in Chat go both ways
    const log = page.getByRole('region', { name: 'Run log' });
    await log.waitFor();
    const knot = (name: RegExp) => log.getByRole('button', { name });
    const planKnot = knot(/^Step plan · done/);
    // `has` is relative to the li: a locator that starts at `log` would match nothing inside it
    const planLi = log.locator('li.sx-knot', { has: page.getByRole('button', { name: /^Step plan · done/ }) });
    const expanded = (k: Locator) => k.getAttribute('aria-expanded');
    await expect.poll(() => expanded(planKnot), { timeout: W }).toBe('false');
    expect(await planKnot.getAttribute('aria-controls')).toBeNull();
    expect(await planLi.locator('.msg.agent').count()).toBe(0);
    await planKnot.click();
    await expect.poll(() => expanded(planKnot), { timeout: W }).toBe('true');
    const track = await planKnot.getAttribute('aria-controls');
    expect(await page.locator(`ol[id="${track}"]`).count()).toBe(1);
    await planLi.locator('.msg.agent', { hasText: 'ONE' }).waitFor();
    await planKnot.click();
    await expect.poll(() => expanded(planKnot), { timeout: W }).toBe('false');
    for (const name of [/^Step wait until \(gate-1\) · done/, /^Step wait until \(gate-2\) · done/, /^Step run command \(run-1\) · done/]) {
      expect(await knot(name).count()).toBe(1);
    }
    // every knot open: no raw JSON in any line
    const strand = log.locator('li.sx-strand');
    for (const t of await strand.locator('.sx-kbtn').all()) if ((await expanded(t)) === 'false') await t.click();
    expect(await strand.locator('.sx-kbtn[aria-expanded="false"]').count()).toBe(0);
    expect(await log.locator('.row', { hasText: '{"step"' }).count()).toBe(0);
    const lastKnot = await strand.locator('li.sx-knot').last().boundingBox();
    const receipt = await log.getByRole('region', { name: 'Receipt for live' }).boundingBox();
    expect(receipt!.y).toBeGreaterThan(lastKnot!.y);
    // Blocks ↗: the Blocks tab selects the block and gives it the focus
    await log.getByRole('button', { name: 'Show plan in Blocks' }).click();
    await expect.poll(() => tab('Blocks').getAttribute('aria-selected'), { timeout: W }).toBe('true');
    await page.locator('.blk[data-id="plan"][aria-current="true"]').waitFor();
    await expect.poll(() => page.evaluate('document.activeElement && document.activeElement.dataset.id'), { timeout: W }).toBe('plan');
    // Show in Chat: the block's menu opens that step's knot and focuses its toggle
    await page.locator('.blk[data-id="build"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Show in Chat' }).click();
    await expect.poll(() => tab('Chat').getAttribute('aria-selected'), { timeout: W }).toBe('true');
    const buildKnot = knot(/^Step build/);
    await buildKnot.waitFor();
    await expect.poll(() => page.evaluate('document.activeElement && document.activeElement.classList.contains("sx-kbtn") && document.activeElement.closest("li").dataset.knot'), { timeout: W })
      .toBe(await buildKnot.locator('xpath=ancestor::li[1]').getAttribute('data-knot'));
    expect(await expanded(buildKnot)).toBe('true');
    const logBox = await log.boundingBox();
    const buildBox = await buildKnot.boundingBox();
    expect(buildBox!.y).toBeGreaterThanOrEqual(logBox!.y);
    expect(buildBox!.y + buildBox!.height).toBeLessThanOrEqual(logBox!.y + logBox!.height);
    // L1b: correctness on a scrollable replay; the 500-row measurements run manually in spike/verify/live/perf.mjs.
    expect(await log.locator('.sx-nowbar [role="status"]').count()).toBe(1);
    const c = await fetch(new URL('/api/sessions', srv.url), { method: 'POST', headers: { Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: folderB, engine: 'claude' }) }).then(async (r) => { expect(r.ok).toBe(true); return r.json(); }) as { id: string };
    const initialSeq = store!.readLog(c.id).at(-1)?.seq ?? 0;
    const add = (type: string, data: unknown, runId?: string) => store!.appendLog(c.id, { type, data, ...(runId ? { runId } : {}) });
    for (let turn = 0; turn < 6; turn++) {
      add('message', { text: `Synthetic turn ${turn}` });
      for (let j = 0; j < 8; j++) add('engine', { type: 'text', text: `Turn ${turn} line ${j}` });
      add('engine', { type: 'tool_call', tool: 'Read', input: { path: 'sample.txt' } });
      add('engine', { type: 'tool_result', tool: 'Read', output: 'output\n'.repeat(80) });
      add('engine', { type: 'tool_call', tool: 'Edit', input: { path: 'sample.txt' } });
      add('engine', { type: 'refusal', reason: 'read-only' });
      for (let j = 0; j < 7; j++) add('engine', { type: 'text', text: `Turn ${turn} tail ${j}` });
      add('turn_ended', { cost: 0.01 });
    }
    add('message', { text: 'Last synthetic turn' });
    add('engine', { type: 'tool_call', tool: 'Read', input: { path: 'last.txt' } });
    add('engine', { type: 'tool_result', tool: 'Read', output: 'last output\n'.repeat(80) });
    const last = add('engine', { type: 'text', text: 'LAST-130' });
    expect(last.seq - initialSeq).toBe(130);
    await page.evaluate(`location.hash = ${JSON.stringify(`s=${c.id}`)}`);
    await page.reload();
    await tab('Chat').click();
    await log.locator(`[data-seq="${last.seq}"]`, { hasText: 'LAST-130' }).waitFor();
    const bottom = () => log.evaluate((el: any) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
    await expect.poll(bottom).toBe(true);
    expect(await log.evaluate((el: any) => el.scrollHeight > el.clientHeight)).toBe(true);
    expect(await log.locator('.sx-track').first().evaluate((el: any) => el.ownerDocument.defaultView.getComputedStyle(el).contentVisibility)).toBe('auto');
    const lastTool = log.locator('.sx-turn').last().locator('details.tool');
    expect(await lastTool.locator('pre').count()).toBe(0);
    await lastTool.locator('summary').click();
    await lastTool.locator('pre.result').waitFor();
    await expect.poll(bottom).toBe(true);
    await log.evaluate((el: any) => { el.scrollTop = 0; });
    await expect.poll(() => log.evaluate((el: any) => el.scrollTop)).toBe(0);
    expect(await page.getByRole('button', { name: 'Jump to live ↓' }).count()).toBe(0);
    await page.getByRole('textbox', { name: 'Message' }).fill('ping');
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    await page.getByRole('button', { name: 'Jump to live ↓' }).waitFor();
    await page.locator('.chead .status.idle').waitFor();
    await log.focus();
    await page.keyboard.press('End');
    await expect.poll(bottom).toBe(true);
    await expect.poll(() => page.getByRole('button', { name: 'Jump to live ↓' }).count()).toBe(0);
    expect(await log.locator('.sx-nowbar [role="status"]').innerText()).toBe('');

    // A held synthetic running knot proves live motion, reduced motion, and silent rows do not multiply working beads.
    add('run_started', { workflow: 'motion', steps: [{ id: 'working', kind: 'phase', title: 'working' }] }, 'motion');
    add('step_started', { step: 'working', parents: [] }, 'motion');
    add('engine', { type: 'tool_call', tool: 'Read', input: { path: 'held.txt' } }, 'motion');
    for (let i = 0; i < 2; i++) add('engine', { type: 'hook', event: 'token' }, 'motion');
    await page.reload();
    const running = log.locator('.sx-knot[data-running="true"]');
    await running.locator('.sx-working').waitFor();
    expect(await running.locator('.sx-working').count()).toBe(1);
    expect(await running.locator('.sx-new').count()).toBe(0);
    expect(await running.locator('.sx-spin').count()).toBe(1);
    expect(await running.locator('.sx-seg').evaluate((el: any) => el.getAnimations({ subtree: true }).map((a: any) => a.animationName))).toContain('sx-flow');
    expect(await running.locator('.sx-wave').evaluate((el: any) => el.getAnimations().map((a: any) => a.animationName))).toContain('sx-breathe');
    expect(await running.locator('.sx-spin').evaluate((el: any) => el.getAnimations().map((a: any) => a.animationName))).toContain('sx-spin');
    await expect.poll(() => running.evaluate((el: any) => el.getAnimations({ subtree: true }).length)).toBeGreaterThan(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => running.evaluate((el: any) => el.getAnimations({ subtree: true }).length)).toBe(0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    await rail.locator('.group', { has: page.locator('header', { hasText: path.basename(folderA) }) }).locator('button.item').click();
    await openLive();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const firstGate = log.locator('li.sx-knot', { has: page.getByRole('button', { name: /^Step wait until \(gate-1\)/ }) }).last();
    await firstGate.getByRole('region', { name: 'gate question' }).waitFor();
    expect(await log.locator('.sx-nowbar [role="status"]').innerText()).toBe('Now: wait until · waiting for you');
    expect(await log.locator('.sx-nowbar').evaluate((el: any) => el.ownerDocument.defaultView.getComputedStyle(el).position)).toBe('sticky');
    await firstGate.locator('.sx-kbtn').click({ force: true });
    expect(await firstGate.locator('.sx-kbtn').getAttribute('aria-expanded')).toBe('true');
    expect(await firstGate.locator('.sx-seg').evaluate((el: any) => el.getAnimations().length)).toBe(0);
    await page.getByRole('textbox', { name: 'Message' }).fill('hold on');
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    await firstGate.locator('.sx-new', { hasText: 'steer card hold on · queued' }).waitFor();
    const qid = await firstGate.locator('[data-qid]').getAttribute('data-qid');
    await firstGate.getByRole('button', { name: 'Approve' }).click();
    const secondGate = log.locator('li.sx-knot', { has: page.getByRole('button', { name: /^Step wait until \(gate-2\)/ }) }).last();
    await secondGate.locator(`[data-qid]:not([data-qid="${qid}"])`).waitFor();
    await secondGate.getByRole('button', { name: 'Approve' }).click();
    await expect.poll(() => log.locator('.sx-nowbar [role="status"]').innerText()).toBe('');
    await firstGate.locator('.sx-kbtn').click();
    expect(await firstGate.locator('.sx-new').count()).toBe(0);
    expect(errors).toEqual([]);
  }, T);
});
