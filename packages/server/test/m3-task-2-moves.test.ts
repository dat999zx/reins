// M3 Task 2: the printed lines and the receipt of the built-in kinds stay byte for byte when their events move out of run-cli.ts and receipt.ts
// into each kind's own `print` and `count`. The expected text below was recorded at HEAD before the move.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { FakeEngine, type ScriptedTurn } from '@reins/core';
import { startRunCli } from '../src/run-cli.js';
import { openStore } from '../src/store.js';
import { usePack } from './pack-helper.js';

usePack(); // M3 Task 3: the built-in kinds are the default pack's mods; this file loads the pack once

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const WF = [
  '---', 'reins: 1', 'name: pin', 'budget: { turns: 40, minutes: 9 }', 'always: []', '---', '',
  '## recall', 'knowl: upload', '',
  '## phase plan', '> plan it', '',
  '## verify', 'against: plan', 'on-fail: plan (max 2)', '',
  '## model m1', '',
  '## repeat', 'until: agent says done', 'max: 3', '', '### phase work', '> work', '',
  '## store', 'knowl: decision', '',
  '## gate', 'until: you approve', '',
].join('\n');

const turn = (text: string): ScriptedTurn => ({ text, cost: 0.01 });
const SCRIPT = [turn('plan'), turn('REINS: fail: nothing'), turn('plan again'), turn('REINS: pass'), turn('REINS: working'), turn('REINS: done'), turn('decision')];

async function runIt() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-m3t2-'));
  dirs.push(dir);
  const file = path.join(dir, 'w.reins.md');
  fs.writeFileSync(file, WF);
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8');
  output.on('data', (d: string) => { text += d; });
  const store = openStore(':memory:');
  const res = await startRunCli({ file, cwd: dir, store, yes: true, input: new PassThrough(), output, makeEngine: () => new FakeEngine(SCRIPT) }).done;
  store.close();
  return { res, text };
}

describe('M3 Task 2: what the CLI prints and the receipt counts for the built-in kinds', () => {
  it('prints the kind lines and the receipt as before', async () => {
    const { res, text } = await runIt();
    expect(res.status).toBe('done');
    const lines = text.split('\n');
    const kept = lines.filter((l) => /^(↻|✓ verify|✗ verify|· recall|· store|· model)/.test(l) || /cannot switch/.test(l));
    expect(kept).toEqual(PRINTED);
    const at = lines.indexOf('── Receipt ──');
    expect(lines.slice(at + 1).filter((l) => !l.startsWith('run id')).map((l) => l.replace(/\$\d\.\d+/g, '$X'))).toEqual(RECEIPT_LINES);
    const r = res.receipt!;
    expect({ g: r.gatesHeld, l: r.loopAttempts, v: r.verifyResults, kr: r.knowlRecalls, ks: r.knowlStores, sk: r.knowlSkipped, c: r.counts }).toEqual(RECEIPT_FIELDS);
  }, 30_000);
});

const PRINTED: string[] = [
  '· recall skipped: Knowl is not wired up until Phase 6',
  '✗ verify: fail',
  '✓ verify: pass',
  "· model-1: this runner cannot switch models; the steps run on the CLI's model",
  '↻ repeat-1: attempt 1',
  '· store skipped: Knowl is not wired up until Phase 6',
];
const RECEIPT_LINES: string[] = [
  'workflow pin · done · 7 turns · 0 s · $X',
  'gates held 1 · refusals 0 (guard 0, read-only 0) · loop attempts 1',
  'cards: live delivered 0, auto fired 0 · verify 1 pass / 1 fail · Knowl 0 recalls, 0 stores, 2 skipped',
  '',
];
const RECEIPT_FIELDS = { g: 1, l: 1, v: { passed: 1, failed: 1 }, kr: 0, ks: 0, sk: 2, c: undefined };
