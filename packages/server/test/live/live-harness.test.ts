// The live harness proves itself here, always on, no env: a sweep that finds a planted key, a Budget that throws at 1.00, a cost check that
// fails by one cent, an evidence writer that refuses a key. Without these the live rows could pass by checking nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Budget, BudgetExceeded, FALLBACK_PRICE, PROVIDERS, costOf, rawUsage, record, sameCost, skipReason, sweep, twice, conversationLines, hiddenOutput, shellOutput } from './live-harness.js';

const KEY = 'sk-ant-api03-Zk3Qp9xT7mV2nB8cLd4Rw6Yh1JgF5aSe0UoXiKtNvMb';
const TAIL = KEY.slice(-8);
const dirs: string[] = [];
const temp = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-live-test-')));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('sweep', () => {
  it('finds nothing in a clean folder', () => {
    const d = temp();
    fs.mkdirSync(path.join(d, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(d, 'a', 'b', 'x.txt'), 'nothing here');
    const r = sweep(d, KEY, [{ name: 'sse', text: 'data: {}' }]);
    expect(r.hits).toEqual([]);
    expect(r.files).toBe(1);
  });

  it('a key planted in a written file fails the sweep, and the report does not repeat it', () => {
    const d = temp();
    fs.mkdirSync(path.join(d, 'deep'));
    fs.writeFileSync(path.join(d, 'deep', 'notes.txt'), `before ${KEY} after`);
    const r = sweep(d, KEY);
    expect(r.hits).toEqual([{ where: path.join('deep', 'notes.txt'), part: 'full' }, { where: path.join('deep', 'notes.txt'), part: 'tail' }]);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(JSON.stringify(r)).not.toContain(TAIL);
  });

  it('only the last 8 characters of the key is a hit of its own', () => {
    const d = temp();
    fs.writeFileSync(path.join(d, 'part.txt'), `...${TAIL}`);
    expect(sweep(d, KEY).hits).toEqual([{ where: 'part.txt', part: 'tail' }]);
  });

  it('a binary file is searched as bytes', () => {
    const d = temp();
    fs.writeFileSync(path.join(d, 'db.sqlite'), Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from(KEY), Buffer.from([0, 0])]));
    expect(sweep(d, KEY).hits.map((h) => h.part)).toEqual(['full', 'tail']);
  });

  it('a file NAME that is the key is a hit, and the name is not repeated', () => {
    const d = temp();
    fs.writeFileSync(path.join(d, `${KEY}.txt`), 'x');
    const r = sweep(d, KEY);
    expect(r.hits.length).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('a captured text (an SSE body, the server output) is searched too', () => {
    const d = temp();
    const r = sweep(d, KEY, [{ name: 'sse stream', text: `data: ${KEY}\n\n` }, { name: 'server stderr', text: 'fine' }]);
    expect(r.hits.map((h) => h.where)).toEqual(['sse stream', 'sse stream']);
  });

  it('a link is not followed', () => {
    const d = temp();
    const outside = temp();
    fs.writeFileSync(path.join(outside, 'k.txt'), KEY);
    try { fs.symlinkSync(outside, path.join(d, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { return; }
    expect(sweep(d, KEY).hits).toEqual([]);
  });

  it('refuses a secret too short to mean anything', () => {
    expect(() => sweep(temp(), 'short')).toThrow(/at least 8/);
  });
});

describe('Budget', () => {
  it('throws before the next call once USD 1.00 is reached by its own count', () => {
    const b = new Budget();
    b.add(0.6);
    expect(() => b.check()).not.toThrow();
    b.add(0.4);
    expect(() => b.check()).toThrow(BudgetExceeded);
  });

  it('a count over 1.00 throws, and a negative or NaN cost is refused', () => {
    const b = new Budget();
    b.add(1.25);
    expect(() => b.check()).toThrow(/used up/);
    expect(() => new Budget().add(-1)).toThrow();
    expect(() => new Budget().add(Number.NaN)).toThrow();
  });

  it('counts the raw usage rows of a conversation file at the manifest price, never the cost field written there', () => {
    const d = temp();
    fs.mkdirSync(path.join(d, 'conversations'));
    // 1,000,000 input tokens at 15 USD per million = 15 USD, whatever cost the line claims.
    const line = { t: 'msg', role: 'assistant', blocks: [], usage: { model: 'm', input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.0001 } };
    fs.writeFileSync(path.join(d, 'conversations', 'abcdefgh.jsonl'), `${JSON.stringify(line)}\n`);
    const b = new Budget();
    b.watch(() => rawUsage(conversationLines(d, 'abcdefgh')).reduce((a, u) => a + costOf(u, FALLBACK_PRICE), 0));
    expect(b.spent).toBeCloseTo(15, 9);
    expect(() => b.check()).toThrow(BudgetExceeded);
  });

  it('a torn last line of the file does not stop the count', () => {
    const d = temp();
    fs.mkdirSync(path.join(d, 'conversations'));
    const line = { t: 'usage', alone: true, model: 'm', input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };
    fs.writeFileSync(path.join(d, 'conversations', 'abcdefgh.jsonl'), `${JSON.stringify(line)}\n{"t":"msg","role":"ass`);
    expect(rawUsage(conversationLines(d, 'abcdefgh'))).toHaveLength(1);
  });
});

describe('the cost row compares to the cent', () => {
  const price = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
  const usage = { input: 3000, output: 1000, cacheRead: 2000, cacheWrite: 500 };

  it('costOf adds input, output, cache read and cache write at their own prices', () => {
    expect(costOf(usage, price)).toBeCloseTo((3000 * 1 + 1000 * 5 + 2000 * 0.1 + 500 * 1.25) / 1e6, 12);
  });

  it('a cache price that is not given is the input price', () => {
    expect(costOf({ input: 0, output: 0, cacheRead: 10, cacheWrite: 10 }, { input: 2, output: 3 })).toBeCloseTo(40 / 1e6, 12);
  });

  it('the same cost passes', () => {
    expect(sameCost(0.0312, 0.0312)).toBe(true);
    expect(sameCost(0.0312, 0.0312 + 1e-9)).toBe(true);
  });

  it('a cost off by one cent fails', () => {
    expect(sameCost(0.03, 0.04)).toBe(false);
    expect(sameCost(1.234, 1.244)).toBe(false);
    expect(sameCost(0.0149, 0.0151)).toBe(false); // across a cent boundary
  });
});

describe('the evidence writer', () => {
  it('appends one block per row with "swept: 0 hits", and no key', () => {
    const file = path.join(temp(), 'evidence.md');
    const a = record({ row: '2', model: 'm', pass: true, cost: 0.0123, counts: { cards: 1 }, swept: { files: 4, unreadable: 0, hits: [] }, notes: ['a note'] }, { file, mode: 'dry', secrets: [KEY] });
    record({ row: '3', model: 'm', pass: 'inconclusive', notes: ['reply length 12'] }, { file, mode: 'dry', secrets: [KEY] });
    const text = fs.readFileSync(file, 'utf8');
    expect(text.match(/^## Row /gm)).toHaveLength(2);
    expect(a).toContain('swept: 0 hits (4 files)');
    expect(a).toContain('| dry | m | PASS');
    expect(text).toContain('INCONCLUSIVE');
    expect(text).not.toContain(KEY);
  });

  it('refuses a block that holds the key or its last 8 characters, and writes nothing', () => {
    const file = path.join(temp(), 'evidence.md');
    expect(() => record({ row: '6', model: 'm', pass: true, notes: [`oops ${KEY}`] }, { file, mode: 'dry', secrets: [KEY] })).toThrow(/holds a key/);
    expect(() => record({ row: '6', model: 'm', pass: true, notes: [`oops ${TAIL}`] }, { file, mode: 'dry', secrets: [KEY] })).toThrow(/holds a key/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('a dry run writes to a file of its own, not the evidence file', async () => {
    const { evidenceFile } = await import('./live-harness.js');
    const saved = process.env.REINS_LIVE_EVIDENCE;
    delete process.env.REINS_LIVE_EVIDENCE;
    try {
      expect(path.basename(evidenceFile('real'))).toBe('p-real-checks.md');
      expect(path.basename(evidenceFile('dry'))).toBe('p-real-checks-dry.md');
    } finally {
      if (saved !== undefined) process.env.REINS_LIVE_EVIDENCE = saved;
    }
  });
});

describe('modes and skips', () => {
  it('nothing runs without a mode, and says how to turn it on', () => {
    expect(skipReason({}, 'off', {})).toMatch(/REINS_LIVE=1/);
  });

  it('a real run without the key of its row is skipped with the variable named, a dry run is not', () => {
    expect(skipReason({ key: 'anthropic' }, 'real', {})).toBe('REINS_LIVE_ANTHROPIC_KEY is not set');
    expect(skipReason({ key: 'openrouter' }, 'real', { REINS_LIVE_OPENROUTER_KEY: 'x' })).toBeUndefined();
    expect(skipReason({ key: 'gemini' }, 'dry', {})).toBeUndefined();
  });

  it('a row with no key needs none', () => {
    expect(skipReason({}, 'real', {})).toBeUndefined();
  });

  it('the key variables are the three the orchestrator sets', () => {
    expect(Object.values(PROVIDERS).map((p) => p.keyVar)).toEqual(['REINS_LIVE_ANTHROPIC_KEY', 'REINS_LIVE_OPENROUTER_KEY', 'REINS_LIVE_GEMINI_KEY']);
  });

  it('the made-up dry keys are long enough to be swept for and differ every time', () => {
    for (const p of Object.values(PROVIDERS)) {
      const a = p.shape();
      expect(a.length).toBeGreaterThan(30);
      expect(p.shape()).not.toBe(a);
    }
  });
});

describe('a hidden variable', () => {
  it('an echo that printed nothing, or only the redaction marker, is hidden; anything else is not', () => {
    expect(hiddenOutput('exit 0')).toBe(true);
    expect(hiddenOutput('\r\nexit 0')).toBe(true);
    expect(hiddenOutput('[key REINS_LIVE_ANTHROPIC_KEY]\nexit 0')).toBe(true);
    expect(hiddenOutput('sk-ant-api03-something\nexit 0')).toBe(false);
    expect(hiddenOutput('absent\nexit 0')).toBe(false);
  });

  it('the output of a shell result is what comes before its exit line', () => {
    expect(shellOutput('line one\nline two\nexit 0')).toBe('line one\nline two');
  });
});

describe('off-task answers', () => {
  it('a task that was done is not retried', async () => {
    let n = 0;
    const r = await twice(async () => ({ onTask: true, n: ++n }), async () => ({ onTask: true, n: ++n }));
    expect(r).toEqual({ result: { onTask: true, n: 1 }, tries: 1 });
  });

  it('a task that was not done is retried once, and then given up', async () => {
    let n = 0;
    const r = await twice(async () => ({ onTask: false, n: ++n }), async () => ({ onTask: false, n: ++n }));
    expect(r).toEqual({ result: { onTask: false, n: 2 }, tries: 2 });
  });
});
