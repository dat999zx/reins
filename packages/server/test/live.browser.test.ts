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
const P = { fixture: 'claude-2.1.281-turns-thinking.jsonl', turn: 0, delayMs: 60 };
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
    fs.writeFileSync(path.join(folderA, '.reins', 'workflows', 'live2.reins.md'), LIVE('node -v').replace('name: live\n', 'name: live2\n'));
    fs.writeFileSync(path.join(folderA, '.reins', 'workflows', 'decl.reins.md'), LIVE('node -p 1').replace('name: live\n', 'name: decl\n'));
    fs.mkdirSync(path.join(folderB, '.reins', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(folderB, '.reins', 'workflows', 'other.reins.md'), '---\nreins: 1\nname: other\nbudget: { turns: 40, minutes: 30, usd: 4.00 }\nalways: []\n---\n\n## phase solo\n> Do it.\n\n## gate\nuntil: you approve\n');
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
    // generic.tsx pretty-prints (`{\n  "step": ...`) into a <pre>, closed or not: the text of every one of them holds no key
    expect(await log.locator('.row.muted pre').filter({ hasText: /"step"\s*:/ }).count()).toBe(0);
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

    // L6. The plan turn thought (the derived fixture): one line for the whole burst, a count and never text, and no "working…" bead beside it
    const l0 = log.locator(`li.sx-strand[data-run="${await strand.getAttribute('data-run')}"]`);
    const l0Plan = l0.locator('li.sx-knot', { has: page.getByRole('button', { name: /^Step plan · done/ }) });
    if ((await expanded(l0Plan.getByRole('button', { name: /^Step plan/ }))) === 'false') await l0Plan.getByRole('button', { name: /^Step plan/ }).click();
    await l0Plan.locator('.msg.agent', { hasText: 'ONE' }).waitFor();
    expect(await l0Plan.locator('.row.think').count()).toBe(1);
    expect(await l0Plan.locator('.row.think').textContent()).toBe('thought ~1,509 tokens'); // textContent: a skipped (content-visibility) track has no innerText
    expect(await l0Plan.locator('.sx-working').count()).toBe(0);

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
    // the thinking count is in the visible Now button, never in the live region (it changes at every burst)
    add('engine', { type: 'thinking', tokens: 321 }, 'motion');
    await page.reload();
    await log.locator('.sx-nowbar button', { hasText: 'thinking… ~321 tokens' }).waitFor();
    expect(await log.locator('.sx-nowbar [role="status"]').innerText()).toBe('Now: working · running');

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
    // L2. Run from Blocks stays here; held tool and gate questions use the same cards in the dock.
    await page.locator('.chead .status.idle').waitFor();
    await tab('Blocks').click();
    await page.locator('.wflist button', { has: page.locator('.sx-wfname', { hasText: /^live2$/ }) }).click();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect.poll(() => tab('Blocks').getAttribute('aria-selected')).toBe('true');
    const dock = page.getByRole('region', { name: 'Run', exact: true });
    const dockCard = (kind: string) => dock.getByRole('region', { name: `${kind} question` });
    const chip = (id: string, state: string) => page.locator(`.blk[data-id="${id}"] .sstate[aria-label^="${state}"]`).first();
    await dockCard('trust').getByRole('button', { name: 'Trust', exact: true }).click();
    await dockCard('tool').waitFor();
    await chip('plan', 'running').waitFor();
    await dock.getByRole('status').getByText('Waiting for you · tool question', { exact: false }).waitFor();
    expect(await page.getByRole('button', { name: 'Run', exact: true }).getAttribute('title')).toBe('A run or a chat turn is going. Stop it first.');
    expect(await page.getByRole('button', { name: 'Run', exact: true }).isDisabled()).toBe(true);
    await tab('Text').click();
    await page.locator('.receives li[aria-current="step"]').getByRole('button', { name: 'phase plan' }).waitFor();
    await tab('Blocks').click();
    // allow every tool question until the gate shows; a card that goes away between the look and the click is not an error
    await expect.poll(async () => {
      if (await dockCard('gate').isVisible()) return true;
      const allow = dockCard('tool').getByRole('button', { name: 'Allow', exact: true });
      if (await allow.isVisible()) await allow.click({ timeout: 2000 }).catch(() => undefined);
      return false;
    }, { timeout: 30_000 }).toBe(true);
    await dock.getByRole('status').getByText('Waiting for you', { exact: false }).waitFor();
    await tab('Text').click();
    await page.locator('.ebar [role="status"]', { hasText: 'Waiting for you. Answer in Blocks or Chat.' }).waitFor();
    await page.locator('.ebar').getByRole('button', { name: 'Blocks', exact: true }).click();
    await page.reload();
    await dockCard('gate').waitFor();
    await chip('gate-1', 'waiting').waitFor();
    expect(await page.locator('.blk[data-id="gate-1"] > .sx-cue.sx-cue-waiting').count()).toBe(1); // the state cue, a child span of the block
    await dockCard('gate').getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => page.evaluate('!!document.activeElement?.closest(".sx-dock")')).toBe(true);
    await chip('gate-2', 'waiting').waitFor();
    await dockCard('gate').getByRole('button', { name: 'Approve', exact: true }).click();
    await dock.getByRole('status').getByText('Done ·', { exact: false }).waitFor();
    await tab('Text').click();
    const editor = page.getByRole('textbox', { name: 'Workflow text' });
    await editor.fill(`${await editor.inputValue()} `);
    await tab('Blocks').click();
    expect(await page.getByRole('button', { name: 'Run', exact: true }).getAttribute('title')).toBe('Save first: a run uses the saved file.');
    await tab('Text').click();
    await editor.press('ControlOrMeta+S');
    const note = (re: RegExp) => page.locator('.note[role="status"]', { hasText: re });
    await note(/^Saved\.$/).waitFor();

    // L3. Steer from the dock, a save during a run says it applies next time, Stop and Dismiss in the dock.
    await tab('Blocks').click();
    await page.locator('.wflist button', { has: page.locator('.sx-wfname', { hasText: /^live$/ }) }).click();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await chip('gate-1', 'waiting').waitFor();
    await tab('Text').click();
    await editor.fill(`${await editor.inputValue()}\n`);
    await editor.press('ControlOrMeta+S');
    await note(/applies to the next run/).waitFor();
    await tab('Blocks').click();
    const steer = dock.getByRole('textbox', { name: 'Steer the agent' });
    // a slow reply, and Enter twice: one card goes
    let posted = 0;
    await page.route('**/api/sessions/*/card', async (r) => { posted++; await new Promise((ok) => setTimeout(ok, 500)); await r.continue(); });
    await steer.fill('use pnpm');
    await steer.press('Enter');
    await steer.press('Enter');
    await expect.poll(() => steer.inputValue()).toBe('');
    expect(posted).toBe(1);
    await page.unroute('**/api/sessions/*/card');
    await tab('Chat').click();
    await log.getByText('steer card use pnpm', { exact: false }).waitFor();
    await page.getByRole('textbox', { name: 'Message' }).fill('End with PINEAPPLE.');
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    await tab('Blocks').click();
    const sent = dock.getByRole('list', { name: 'Cards sent' }).getByRole('listitem');
    await sent.filter({ hasText: 'use pnpm' }).getByText('queued').waitFor();
    await sent.filter({ hasText: 'End with PINEAPPLE.' }).getByText('queued').waitFor();
    await dockCard('gate').getByRole('button', { name: 'Approve', exact: true }).click();
    await chip('gate-2', 'waiting').waitFor();
    await sent.filter({ hasText: 'use pnpm' }).getByText('delivered').waitFor();
    await sent.filter({ hasText: 'End with PINEAPPLE.' }).getByText('delivered').waitFor();
    await dock.locator('.sx-steer').getByRole('button', { name: 'Stop', exact: true }).click(); // the gate card has its own Stop
    await dock.getByRole('status').getByText('Stopped at `gate-2`', { exact: false }).waitFor();
    await expect.poll(() => page.locator('.blk[data-id="gate-2"] .sx-ended').innerText()).toBe('stopped here');
    expect(await page.locator('.blk[data-id="gate-2"] > .sx-cue.sx-cue-ended-stopped').count()).toBe(1);
    await dock.getByRole('button', { name: 'Dismiss', exact: true }).click();
    expect(await page.locator('.blk .sstate').count()).toBe(0);
    expect(await dock.count()).toBe(0);
    await tab('Chat').click();
    await tab('Blocks').click();
    expect(await page.locator('.blk .sstate').count()).toBe(0);
    expect(await dock.count()).toBe(0);
    // a dismissed run offers no Show in Chat: the block ran in it, but the file no longer shows that run
    await page.locator('.blk[data-id="plan"]').click({ button: 'right' });
    await page.getByRole('menu').waitFor();
    expect(await page.getByRole('menuitem', { name: 'Show in Chat' }).count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Show in Chat' }).count()).toBe(0);
    await page.keyboard.press('Escape');

    // L4. Follow keeps the running block in view until the user moves the camera; pressing Follow brings it back.
    const view = page.locator('.sx-view');
    const block = (id: string) => page.locator(`.blk[data-id="${id}"]`);
    const inside = async (id: string) => {
      const b = await block(id).boundingBox(), v = await view.boundingBox();
      return !!b && !!v && b.x >= v.x && b.y >= v.y && b.x + b.width <= v.x + v.width && b.y + b.height <= v.y + v.height;
    };
    const apart = async (id: string) => {
      const b = await block(id).boundingBox(), v = await view.boundingBox();
      return !!b && !!v && (b.x + b.width < v.x || b.y + b.height < v.y || b.x > v.x + v.width || b.y > v.y + v.height);
    };
    // a point of bare surface (the view itself is the element there), then a drag from it
    const pan = async (dx: number, dy: number) => {
      const s = await page.evaluate(`(() => {
        const v = document.querySelector('.sx-view'), r = v.getBoundingClientRect();
        for (let y = r.top + 60; y < r.bottom - 60; y += 20) for (let x = r.right - 30; x > r.left + 30; x -= 20) if (document.elementFromPoint(x, y) === v) return { x, y };
        return null;
      })()`) as { x: number; y: number } | null;
      expect(s).not.toBeNull();
      await page.mouse.move(s!.x, s!.y);
      await page.mouse.down();
      await page.mouse.move(Math.max(5, s!.x + dx), Math.max(5, s!.y + dy), { steps: 6 });
      await page.mouse.up();
    };
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Zoom in' }).click();
    for (let i = 0; i < 6 && !(await apart('plan')); i++) await pan(-250, -150);
    expect(await apart('plan')).toBe(true);
    expect(await note(/Stopped following/).count()).toBe(0); // no run is going: moving the camera is not "stopping Follow"
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await dockCard('tool').waitFor();
    const follow = dock.getByRole('button', { name: 'Follow', exact: true });
    await expect.poll(() => inside('plan')).toBe(true);
    expect(await follow.getAttribute('aria-pressed')).toBe('true');
    await pan(80, 0);
    await expect.poll(() => follow.getAttribute('aria-pressed')).toBe('false');
    await note(/^Stopped following the run\./).waitFor();
    // a reload starts following again (Follow is a page choice, not a stored one); a press in the view stops it once more
    await page.reload();
    await dockCard('tool').waitFor();
    await expect.poll(() => follow.getAttribute('aria-pressed')).toBe('true');
    await pan(80, 0);
    await expect.poll(() => follow.getAttribute('aria-pressed')).toBe('false');
    for (let i = 0; i < 8 && !(await apart('gate-1')); i++) await pan(-250, -250); // the next stop stands outside the view
    expect(await apart('gate-1')).toBe(true);
    await expect.poll(async () => {
      if (await chip('gate-1', 'waiting').isVisible()) return true;
      const allow = dockCard('tool').getByRole('button', { name: 'Allow', exact: true });
      if (await allow.isVisible()) await allow.click({ timeout: 2000 }).catch(() => undefined);
      return false;
    }, { timeout: 30_000 }).toBe(true);
    // Follow off: the running block was not brought along. Follow on again brings it.
    expect(await apart('gate-1')).toBe(true);
    await follow.click();
    expect(await follow.getAttribute('aria-pressed')).toBe('true');
    await expect.poll(() => inside('gate-1')).toBe(true);
    await dockCard('gate').getByRole('button', { name: 'Approve', exact: true }).click();
    await chip('gate-2', 'waiting').waitFor();
    await dockCard('gate').getByRole('button', { name: 'Approve', exact: true }).click();
    await dock.getByRole('status').getByText('Done ·', { exact: false }).waitFor();

    // L5. Two sessions at once: B waits on a gate while A sits finished. Neither shows the other's run; the page title counts the waiting one.
    const sid = () => page.evaluate(`new URLSearchParams(location.hash.slice(1)).get('s')`) as Promise<string>;
    const goA = () => rail.locator('.group', { has: page.locator('header', { hasText: path.basename(folderA) }) }).locator('button.item').click();
    const idA = await sid();
    await page.keyboard.press('ControlOrMeta+O');
    await expect.poll(sid).not.toBe(idA);
    const idB = await sid();
    await tab('Blocks').click();
    await page.locator('.wflist button', { has: page.locator('.sx-wfname', { hasText: /^other$/ }) }).click();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await dockCard('trust').getByRole('button', { name: 'Trust', exact: true }).click();
    await dockCard('gate').waitFor();
    await chip('gate-1', 'waiting').waitFor();
    await expect.poll(() => page.title()).toBe('(1) waiting · Reins');
    // A, finished: its own run, none of B's
    await goA();
    expect(await sid()).toBe(idA);
    await tab('Blocks').click();
    await dock.getByRole('status').getByText('Done ·', { exact: false }).waitFor();
    await chip('plan', 'done').waitFor();
    await dock.getByRole('button', { name: 'Show the run' }).waitFor(); // B's dock was open: that choice stays with B
    expect(await dockCard('gate').count()).toBe(0);
    expect(await page.locator('.blk[data-id="solo"]').count()).toBe(0);
    expect(await page.title()).toBe('(1) waiting · Reins'); // B's, seen from A
    await tab('Chat').click();
    await log.waitFor();
    expect(await knot(/solo/).count()).toBe(0);
    expect(await log.getByRole('button', { name: 'Approve' }).count()).toBe(0);
    expect(await log.locator('.sx-nowbar [role="status"]').innerText()).toBe('');
    // B, waiting: its own run, none of A's
    await page.getByRole('list', { name: 'Waiting for you' }).locator('button.item').click();
    expect(await sid()).toBe(idB);
    await tab('Chat').click();
    await knot(/^Step solo · done/).waitFor();
    expect(await knot(/^Step plan/).count()).toBe(0);
    await expect.poll(() => log.locator('.sx-nowbar [role="status"]').innerText()).toBe('Now: wait until · waiting for you');
    expect(await log.getByRole('button', { name: 'Approve' }).count()).toBe(1);
    // live regions: the feed's Now line is the only one in the log, no row announces itself, and a knot's name holds its visible text
    await knot(/^Step solo · done/).click(); // open, so its rows are mounted and the check below can fail
    await log.locator('.msg.agent').first().waitFor();
    expect(await log.locator('[aria-live], [role="alert"], [role="log"]').count()).toBe(0);
    expect(await log.locator('[role="status"]').count()).toBe(1);
    const kbtns = await log.locator('.sx-kbtn').all();
    expect(kbtns.length).toBe(2);
    for (const k of kbtns) {
      const name = ((await k.getAttribute('aria-label')) ?? '').toLowerCase();
      for (const word of (await k.innerText()).toLowerCase().split(/[\s·]+/).filter((x) => /^[a-z]{3,}$/.test(x))) expect(name, `knot name "${name}" lacks "${word}"`).toContain(word);
    }
    await tab('Blocks').click();
    await dockCard('gate').waitFor();
    await dock.getByRole('status').getByText('Waiting for you', { exact: false }).waitFor();
    expect(await dock.getByRole('status').innerText()).not.toContain('Done');
    await chip('solo', 'done').waitFor();
    expect(await page.locator('.blk[data-id="plan"]').count()).toBe(0);
    expect(await dock.locator('[aria-live], [role="alert"]').count()).toBe(0);
    expect(await dock.locator('[role="status"]').count()).toBe(1);
    // reload with B waiting: the title comes back from the replay
    await page.reload();
    await expect.poll(() => page.title()).toBe('(1) waiting · Reins');
    expect(await sid()).toBe(idB);
    if ((await tab('Blocks').getAttribute('aria-selected')) !== 'true') await tab('Blocks').click();
    await dockCard('gate').waitFor();
    // Escape in the steer box does not clear the canvas selection
    const steerB = dock.getByRole('textbox', { name: 'Steer the agent' });
    await page.locator('.blk[data-id="solo"]').click();
    await expect.poll(() => page.locator('.blk[data-id="solo"].sx-sel').count()).toBe(1);
    await steerB.focus();
    await steerB.press('Escape');
    expect(await page.locator('.blk[data-id="solo"].sx-sel').count()).toBe(1);
    // keyboard: from the canvas back to the dock's toggle (Shift+Tab), Enter toggles it, Tab reaches the steer box
    const focused = (re: string) => page.evaluate(`!!document.activeElement && new RegExp(${JSON.stringify(re)}).test(document.activeElement.closest('.sx-dockline') ? document.activeElement.textContent : document.activeElement.getAttribute('aria-label') ?? '')`);
    await page.locator('[aria-label="Workspace"]').focus();
    let back = 0;
    while (!(await focused('the run$')) && back++ < 8) await page.keyboard.press('Shift+Tab');
    expect(back).toBeLessThanOrEqual(8);
    const toggle = dock.getByRole('button', { name: /the run$/ });
    const wasOpen = await toggle.getAttribute('aria-expanded');
    await page.keyboard.press('Enter');
    await expect.poll(() => toggle.getAttribute('aria-expanded')).not.toBe(wasOpen);
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await page.keyboard.press('Enter');
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true');
    let fwd = 0;
    while (!(await focused('^Steer the agent$')) && fwd++ < 6) await page.keyboard.press('Tab');
    expect(await focused('^Steer the agent$')).toBe(true);
    // Stop in B: B's title and dock change, A's do not
    await dock.locator('.sx-steer').getByRole('button', { name: 'Stop', exact: true }).click();
    await dock.getByRole('status').getByText('Stopped at `gate-1`', { exact: false }).waitFor();
    await expect.poll(() => page.title()).toBe('Reins');
    await goA();
    expect(await sid()).toBe(idA);
    await tab('Blocks').click();
    await dock.getByRole('status').getByText('Done ·', { exact: false }).waitFor();
    expect(await dock.getByRole('status').innerText()).not.toContain('Stopped');

    // L7. A refused start says so in the dock, and Dismiss takes the words away with the run.
    await page.locator('.wflist button', { has: page.locator('.sx-wfname', { hasText: /^decl$/ }) }).click();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await dockCard('trust').getByRole('button', { name: "Don't trust", exact: true }).click();
    await dock.getByRole('status').getByText('The run did not start: The workflow is not trusted, so it did not run.', { exact: false }).waitFor();
    await dock.getByRole('button', { name: 'Dismiss', exact: true }).click();
    expect(await dock.count()).toBe(0);
    expect(errors).toEqual([]);
  }, T);
});
