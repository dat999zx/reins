// M1 acceptance, core half: a block that no src file knows runs end to end from two registrations. Nothing under packages/*/src changed for it.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { register, NODES, parseWorkflow, printWorkflow, validate, compileProgram, receipt, Run } from '@reins/core';
import { harness } from '../../core/test/m1-harness.js';
import { beep } from '../../core/test/fixtures/beep.js';
import { startRunCli } from '../src/run-cli.js';
import { openStore } from '../src/store.js';
import { commandsOf } from '../src/trust.js';
import { claudeEngine } from '../src/claude/engine.js';
import { FAKE_CLAUDE, fakeSetup } from './helpers.js';

const disposers: Array<() => void> = [];
afterEach(() => { for (const d of disposers.splice(0).reverse()) d(); });

const head = '---\nreins: 1\nname: toy\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n';
const text = head + '## beep\ntimes: 2\n\n## phase one\n> go\n';
const parsed = () => parseWorkflow(text);
const none = () => undefined;

describe('a toy block: two registrations and nothing else', () => {
  it('parses, prints back, validates, compiles, runs and counts', async () => {
    disposers.push(register(beep));
    const p = parsed();
    expect(p.diagnostics).toEqual([]);
    const w = p.workflow!;
    expect(printWorkflow(w)).toBe(text);
    expect(validate(w).filter((d) => d.severity === 'error')).toEqual([]);
    expect(compileProgram(w)[0]).toMatchObject({ op: 'BEEP', times: 2 });

    const h = harness('beep', [{ text: 'ok\nREINS: done' }]);
    const run = new Run({ workflow: w, engine: h.engine, now: h.now });
    for (let k = 0; k < 20 && run.status === 'running'; k++) await run.step();
    expect(run.status).toBe('done');
    expect(run.getEvents().filter((e) => e.type === 'beeped').map((e) => e.data)).toEqual([{ step: 'beep-1', times: 2 }]);
    expect(receipt(run.getEvents()).counts).toEqual({ beeps: 1 });
  });

  it('`reins run` prints the block\'s line and the count tail line; the trust list has no command from it', async () => {
    disposers.push(register(beep));
    const f = fakeSetup([]);
    const file = path.join(f.dir, 'w.reins.md');
    fs.writeFileSync(file, text);
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.setEncoding('utf8');
    output.on('data', (d: string) => { out += d; });
    const store = openStore(':memory:');
    const res = await startRunCli({
      file, cwd: f.dir, input, output, store,
      makeEngine: ({ onApprove, onLive }) => claudeEngine({ bin: FAKE_CLAUDE, onApprove, onLive }),
    }).done;
    expect(res.status).toBe('done');
    expect(res.receipt!.counts).toEqual({ beeps: 1 });
    const lines = out.split('\n');
    expect(lines).toContain('  beeped x2');
    expect(lines[lines.findIndex((l) => l.startsWith('run id ')) - 1]).toBe('beeps 1');
    store.close();

    const without = parseWorkflow(head + '## phase one\n> go\n').workflow!;
    expect(commandsOf(parsed().workflow!, none)).toEqual(commandsOf(without, none));
  }, 60_000);

  it('after the disposer the kind is gone and the file gets the normal diagnostic', () => {
    register(beep)();
    expect(NODES.has('beep')).toBe(false);
    expect(parsed().diagnostics.map((d) => d.message).join('\n')).toContain('Unknown step kind');
  });
});
