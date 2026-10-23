// M3 fix round 2, group E1, item N4 (server half): /close and a server stop do not wait for ever on work that never ends. The probe is a run whose block is a copy of a
// built-in (`builtin`, no `pack`) with an op that never settles: the run leaves such an op for a grace (11 minutes) after Stop, so the session puts its own limit on the wait.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { register } from '@reins/core';
import { openSession } from '../src/session.js';
import { openStore } from '../src/store.js';
import { testEngine } from './test-engine.js';
import { usePack } from './pack-helper.js';

usePack();

const tmps: string[] = [];
const disposers: Array<() => void> = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-e1-stop-')); tmps.push(d); return d; };
afterEach(() => {
  for (const d of disposers.splice(0).reverse()) d();
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function until(f: () => boolean) {
  for (let i = 0; i < 1000 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(f(), 'the condition was not met in time').toBe(true);
}
const within = <T>(p: Promise<T>, ms: number, what: string) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} did not end in ${ms} ms`)), ms))]);

/** A session running `## hangblock`, whose op never settles. */
async function hanging(flags: { builtin?: true; pack?: true }, workerWaitMs: number) {
  let reached = false;
  disposers.push(register({
    kind: 'hangblock', attrs: [], mod: { id: 'hangblock', events: [], ...flags },
    compile(step: { id: string }, ctx: { push(i: unknown): void }) { ctx.push({ op: 'HANG', step: step.id }); },
    ops: { HANG: { exec: () => { reached = true; return new Promise<void>(() => {}); } } },
  } as never));
  const store = openStore(':memory:');
  const t = testEngine([{}]);
  const cwd = tmp();
  const row = store.createSession({ id: 's1', cwd, engine: 'claude-code' });
  const s = openSession({ store, makeEngine: t.makeEngine, folderTrust: t.folderTrust, dir: tmp(), workerWaitMs }, row, true);
  const file = path.join(cwd, 'w.reins.md');
  fs.writeFileSync(file, '---\nreins: 1\nname: w\nbudget: { turns: 10, minutes: 10 }\nalways: []\n---\n\n## hangblock\n');
  expect(s.runFile(file)).toEqual({ ok: true });
  const asked = () => store.readLog('s1').filter((r) => r.type === 'question').map((r) => r.data as { id: string; kind: string });
  await until(() => asked().some((q) => q.kind === 'trust'));
  s.answer(asked().find((q) => q.kind === 'trust')!.id, 'y');
  await until(() => reached);
  return { s, store };
}

describe('N4: the session does not wait for ever on work that never ends', () => {
  it('a server stop ends after the wait, with the work still hanging', async () => {
    const { s } = await hanging({ builtin: true }, 150);
    const t0 = Date.now();
    await within(s.shutdown(), 5000, 'shutdown');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  });

  it('/close ends after the wait, and the session is closed', async () => {
    const { s } = await hanging({ builtin: true }, 150);
    await within(s.close(), 5000, 'close');
    expect(s.status()).toBe('closed');
  });

  it('work that ends at once is not waited for: close returns long before the limit', async () => {
    const { s } = await hanging({}, 60_000);   // another mod's op: Stop cuts it at once
    const t0 = Date.now();
    await within(s.close(), 5000, 'close');
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
