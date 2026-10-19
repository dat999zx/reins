// Milestone P, Task 15 (spec 6.2): `reins run` says when replies had no price, and the total says it leaves them out.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { FakeEngine, type ScriptedTurn } from '@reins/core';
import { startRunCli } from '../src/run-cli.js';
import { openStore } from '../src/store.js';

async function runWith(script: ScriptedTurn[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-cli-unpriced-'));
  try {
    const file = path.join(dir, 'w.reins.md');
    fs.writeFileSync(file, '---\nreins: 1\nname: u\nbudget: { turns: 9, minutes: 9 }\nalways: []\n---\n\n## phase one\n> a\n\n## phase two\n> b\n');
    const output = new PassThrough();
    let text = '';
    output.setEncoding('utf8');
    output.on('data', (d: string) => { text += d; });
    const store = openStore(':memory:');
    const h = startRunCli({ file, cwd: dir, store, input: new PassThrough(), output, makeEngine: () => new FakeEngine(script), yes: true });
    const result = await h.done;
    store.close();
    return { text, result };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
const usage = { type: 'usage' as const, model: 'm', used: 10 };

describe('the receipt of reins run, unpriced replies', () => {
  it('two replies with no price: the count line, and the total says "+ ?"', async () => {
    const { text, result } = await runWith([{ text: 'REINS: done', events: [usage] }, { text: 'REINS: done', events: [usage] }]);
    expect(result.receipt!.unpricedTurns).toBe(2);
    expect(text).toContain('$0.0000 + ?');
    expect(text).toContain('2 replies had no price; the total leaves them out');
  });

  it('one reply: singular words', async () => {
    const { text } = await runWith([{ text: 'REINS: done', cost: 0.0123, events: [usage] }, { text: 'REINS: done', events: [usage] }]);
    expect(text).toContain('$0.0123 + ?');
    expect(text).toContain('1 reply had no price; the total leaves it out');
  });

  it('every reply priced: no "?" and no line', async () => {
    const { text } = await runWith([{ text: 'REINS: done', cost: 0.01, events: [usage] }, { text: 'REINS: done', cost: 0.02, events: [usage] }]);
    expect(text).toContain('$0.0300');
    expect(text).not.toContain('+ ?');
    expect(text).not.toContain('had no price');
  });
});
