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

  it('D4 (f): a reply the engine marked unknown marks its model, and the known part of the total stays', async () => {
    const { text } = await runWith([{ text: 'REINS: done', unknownCost: true, events: [usage] }, { text: 'REINS: done', cost: 0.01, events: [usage] }]);
    expect(text).toContain('models m $0.0000 + ? (2 turns) · not split by model $0.0100');
    expect(text).toContain('$0.0100 + ?');
  });

  it('every reply priced: no "?" and no line', async () => {
    const { text } = await runWith([{ text: 'REINS: done', cost: 0.01, events: [usage] }, { text: 'REINS: done', cost: 0.02, events: [usage] }]);
    expect(text).toContain('$0.0300');
    expect(text).not.toContain('+ ?');
    expect(text).not.toContain('had no price');
  });
});

describe('D4 (f): a subagent of unknown cost, in the line it hands back and in the receipt', () => {
  it('shows "$0.0000 + ?" on both, and a priced one does not', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-cli-unpriced-sub-'));
    try {
      const file = path.join(dir, 'w.reins.md');
      fs.writeFileSync(file, '---\nreins: 1\nname: s\nbudget: { turns: 9, minutes: 9 }\nalways: []\n---\n\n## subagent research\nmodel: m1\n> Look.\n\n## subagent other\nmodel: m1\n> Look again.\n');
      const output = new PassThrough();
      let text = '';
      output.setEncoding('utf8');
      output.on('data', (d: string) => { text += d; });
      const store = openStore(':memory:');
      const subs = new FakeEngine([{ text: 'found', unknownCost: true, events: [usage] }, { text: 'again', cost: 0.01, events: [usage] }]);
      const h = startRunCli({
        file, cwd: dir, store, input: new PassThrough(), output, makeEngine: () => new FakeEngine([]), yes: true,
        subagentEngine: () => ({ engine: subs, model: 'm1' }),
      });
      await h.done;
      store.close();
      expect(text).toContain('· subagent-1: handed back its result ($0.0000 + ?)');
      expect(text).toContain('· subagent-2: handed back its result ($0.0100)');
      expect(text).toMatch(/subagents research \$0\.0000 \+ \? \(1 turn\) · other \$0\.0100 \(1 turn\)/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
