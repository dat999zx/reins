// M2 Task 22 (v3 Task 19): on the canvas a cost chip stays off the blocks beside it, and every arrow ends on its own target.
// Headless Chromium against a real server. The finished run is seeded in the log (no engine starts), as live.browser.test does.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { startServer, type Server } from '../src/server.js';
import { openStore, type Store } from '../src/store.js';
import { PROBE, tmpDir, cleanup } from './http-helpers.js';

const APP = fileURLToPath(new URL('../../app/dist/', import.meta.url));
const INDEX = path.join(APP, 'index.html');
const skip = !fs.existsSync(INDEX) && !process.env.CI;
const T = 120_000;
const W = 15_000;

// A phase, a command, a loop with a phase in it and the stack's end; then a free verify and its end, beside the stack.
const WORKFLOW = `---
reins: 1
name: chips
budget: { turns: 40, minutes: 60, usd: 3.00 }
always: []
---

## repeat
until: \`npm test\` passes
max: 5

### phase fix
> Fix it.

## phase plan
next: end-1
> Write a plan.

## run \`npm test\`

## end

## verify
against: plan
on-fail: plan (max 2)

## end
`;

// every step ran and was charged: each block shows a chip with its cost
const RAN = ['repeat-1', 'fix', 'plan', 'run-1', 'end-1', 'verify-1', 'end-2'];
// the run's steps in file order, as the run logs them (the canvas shows the chips only when they match the file)
const STEPS = [['repeat-1', 'repeat'], ['fix', 'phase'], ['plan', 'phase'], ['run-1', 'run'], ['end-1', 'end'], ['verify-1', 'verify'], ['end-2', 'end']]
  .map(([id, kind]) => ({ id, kind }));

type Box = { l: number; t: number; r: number; b: number };
type Pt = { x: number; y: number };

describe.skipIf(skip)('canvas cost chips and arrows (M2 Task 22)', () => {
  let browser: Browser | undefined;
  let srv: Server | undefined;
  let store: Store | undefined;
  afterAll(async () => {
    await browser?.close();
    await srv?.close();
    store?.close();
    await cleanup();
  }, T);

  // `late`: the run is logged AFTER the canvas first painted, so the chips arrive as new text in a page already measured.
  it.each([[false], [true]])('keeps each cost chip off the blocks beside it, and every arrow ends on its own target (chips arrive after first paint: %s)', async (late) => {
    await browser?.close();
    await srv?.close();
    store?.close();
    const folder = tmpDir();
    fs.mkdirSync(path.join(folder, '.reins', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(folder, '.reins', 'workflows', 'chips.reins.md'), WORKFLOW);
    store = openStore(':memory:');
    srv = await startServer({
      store, dir: tmpDir(), appDir: APP, catalogDir: path.join(tmpDir(), 'no-catalog'), // no catalog: a fresh home would show the first-run chooser instead of the app
      probe: async () => PROBE,
      makeEngine: () => { throw new Error('this test starts no run'); },
    });
    const made = await fetch(new URL('/api/sessions', srv.url), { method: 'POST', headers: { Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: folder, engine: 'claude-code' }) });
    expect(made.ok).toBe(true);
    const c = await made.json() as { id: string };
    const add = (type: string, data: unknown) => store!.appendLog(c.id, { type, data, runId: 'run-chips' });
    const seed = () => {
      add('run_started', { workflow: 'chips', steps: STEPS });
      for (const step of RAN) {
        add('step_started', { step, parents: [] });
        add('turn_ended', { step, cost: 0.0123, model: 'claude-haiku-5-5' });
      }
      add('run_finished', {});
    };
    if (!late) seed();

    browser = await chromium.launch();
    const page: Page = await (await browser.newContext()).newPage();
    page.setDefaultTimeout(W);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.addInitScript(`(() => { const E = window.EventSource; window.__es = []; window.EventSource = class extends E { constructor(...a) { super(...a); window.__es.push(this); } }; })()`);
    await page.goto(srv.url);
    await page.evaluate(`location.hash = ${JSON.stringify(`s=${c.id}`)}`);
    await page.reload();
    await page.getByRole('navigation', { name: 'Sessions' }).waitFor();
    await page.getByRole('tab', { name: 'Text' }).click();
    await page.locator('.wflist button', { has: page.locator('.sx-wfname', { hasText: /^chips$/ }) }).click();
    await page.locator('.ebar b', { hasText: 'chips.reins.md' }).waitFor();
    await page.getByRole('tab', { name: 'Blocks' }).click();
    if (late) {
      await page.locator('.blk[data-id="plan"]').waitFor();
      expect(await page.locator('.sx-st .sstate').count()).toBe(0);
      // The server pushes only what a live session writes, so the app is made to reconnect: it replays the rows it has not seen.
      seed();
      await page.evaluate('window.__es.at(-1).dispatchEvent(new Event("error"))');
    }
    await page.locator('.sx-st .sstate').first().waitFor();
    if (late) await page.waitForFunction(`document.querySelectorAll('.sx-st .sstate').length === ${RAN.length}`);
    expect(await page.locator('.sx-st .sstate').count()).toBe(RAN.length);
    await page.waitForTimeout(500); // let the re-measure settle

    // 1. no state chip covers a block (screen pixels). A chip of a block inside a loop sits in that loop's frame: the frame
    // is an ancestor of the chip's own block, so it is not counted here (the loop body is laid out as it was before this task).
    const geo = await page.evaluate(`(() => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
      const ancestors = (el) => { const ids = []; for (let e = el.parentElement?.closest('.blk[data-id]'); e; e = e.parentElement?.closest('.blk[data-id]')) ids.push(e.dataset.id); return ids; };
      return {
        blocks: [...document.querySelectorAll('.blk[data-id]')].map((el) => ({ id: el.dataset.id, ...rect(el) })),
        chips: [...document.querySelectorAll('.sx-st .sstate')].map((el) => ({ text: el.textContent, up: ancestors(el), ...rect(el) })),
      };
    })()`) as { blocks: Array<Box & { id: string }>; chips: Array<Box & { text: string; up: string[] }> };
    const covered = geo.chips.flatMap((ch) => geo.blocks
      .filter((b) => !ch.up.includes(b.id) && ch.l < b.r && ch.r > b.l && ch.t < b.b && ch.b > b.t)
      .map((b) => `chip "${ch.text}" covers ${b.id}`));
    expect(covered).toEqual([]);

    // 2. every arrow's tip lies on the border of the block its label names as the target (within 2 px), and inside no other block.
    // 3. no arrow runs over the cost chip of a block that is neither its source nor its target (the route clears the chips).
    const tips = await page.evaluate(`(() => {
      const chips = [...document.querySelectorAll('.sx-st .sstate')].map((el) => ({ owner: el.closest('.blk[data-id]').dataset.id, r: el.getBoundingClientRect() }));
      return [...document.querySelectorAll('.sx-links g[data-link]')].map((g) => {
        const p = g.querySelector('path:not(.sx-hit)'), m = p.getScreenCTM(), n = p.getTotalLength();
        const at = p.getPointAtLength(n).matrixTransform(m);
        const pts = [];
        for (let d = 0; d <= n; d += 1) pts.push(p.getPointAtLength(d).matrixTransform(m));
        const over = chips.filter((c) => pts.some((q) => q.x > c.r.left + 1 && q.x < c.r.right - 1 && q.y > c.r.top + 1 && q.y < c.r.bottom - 1)).map((c) => c.owner);
        return { label: g.getAttribute('aria-label'), x: at.x, y: at.y, over };
      });
    })()`) as Array<{ label: string; x: number; y: number; over: string[] }>;
    const from = (label: string) => label.split(' link from ')[1]!.split(' to ')[0]!;
    const inside = (p: Pt, b: Box, tol: number) => p.x > b.l + tol && p.x < b.r - tol && p.y > b.t + tol && p.y < b.b - tol;
    const within = (p: Pt, b: Box, tol: number) => p.x >= b.l - tol && p.x <= b.r + tol && p.y >= b.t - tol && p.y <= b.b + tol;
    const wrong = tips.flatMap(({ label, x, y, over }) => {
      const p = { x, y }, to = label.split(' to ')[1]!.split(',')[0]!;
      const target = geo.blocks.find((b) => b.id === to);
      if (!target) return [`${label}: no block ${to}`];
      const bad: string[] = [];
      if (!within(p, target, 2) || inside(p, target, 2)) bad.push(`${label}: tip (${x.toFixed(1)}, ${y.toFixed(1)}) is not on the border of ${to}`);
      // a block that wraps the target (a loop around its phase) is not "another block" for this purpose
      for (const b of geo.blocks) {
        const wraps = b.l <= target.l && b.r >= target.r && b.t <= target.t && b.b >= target.b;
        if (b.id !== to && !wraps && inside(p, b, 2)) bad.push(`${label}: tip (${x.toFixed(1)}, ${y.toFixed(1)}) is inside ${b.id}`);
      }
      for (const owner of over) if (owner !== to && owner !== from(label)) bad.push(`${label}: the route runs over the chip of ${owner}`);
      return bad;
    });
    expect(tips.length).toBeGreaterThanOrEqual(3);
    expect(wrong).toEqual([]);
    expect(errors).toEqual([]);
  }, T);
});
