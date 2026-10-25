// A command that fails (rejects) still flushes what its output stream held back, and under its own run.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FakeEngine, type Workflow } from '@reins/core';

const script = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../src/commands.js', () => ({
  runCommand: async (_cmd: string, o: { onOutput?: (s: string) => void }) => {
    script.calls++;
    if (script.calls === 1) {
      o.onOutput?.('visible sk-t');                       // the start of the key, then the command blows up
      throw new Error('the command could not be run');
    }
    o.onOutput?.('next\n');
    return { exitCode: 0, stdout: 'next\n', stderr: '' };
  },
}));

const { runOptions } = await import('../src/drive.js');
const { Redactor, setKey } = await import('../src/secrets.js');
const { openStore, redactingStore } = await import('../src/store.js');
const { askedQuestion, boot, cleanup, tmpDir } = await import('./http-helpers.js');
const { until } = await import('./helpers.js');

const KEY = 'sk-test-0123456789abcdef';
afterEach(cleanup);

describe('a command that rejects', () => {
  it('drive.ts ends the command output even when the command throws', async () => {
    let ended = 0;
    const o = runOptions({ ask: async () => null, say() {}, write() {}, endOutput: () => { ended++; } }, {
      workflow: {} as Workflow, engine: new FakeEngine(), cwd: process.cwd(), resolveBlock: () => undefined, onEvent() {},
    });
    script.calls = 0;
    await expect(o.commandRunner!('x')).rejects.toThrow('could not be run');
    expect(ended).toBe(1);
  });

  it('a session writes the held key start under the run that had it, and the next run starts clean', async () => {
    const dir = tmpDir();
    setKey(dir, 'p', KEY);
    const redactor = new Redactor({ home: dir, env: {}, keyEnvNames: () => [] });
    const w = await boot([], { store: redactingStore(openStore(':memory:'), redactor), dir, redactor });
    const id = await w.session();
    script.calls = 0;
    const file = path.join(w.cwd, 'a.reins.md');
    fs.writeFileSync(file, '---\nreins: 1\nname: x\ntask: t\nbudget: { turns: 5, minutes: 5 }\n---\n\n## run `anything`\n');

    expect((await w.post(id, 'run', { path: file })).status).toBe(200);
    await w.answer(id, (await askedQuestion(w.store, id, 'trust')).id, 'y');
    await until(() => w.rows(id, 'run_detached').length === 1, 30_000);
    await w.settled(id, 0);
    expect((await w.post(id, 'run', { path: file })).status).toBe(200);
    await until(() => w.rows(id, 'run_finished').length === 1, 30_000);

    const out = w.rows(id, 'command_output');
    const first = out[0]!.runId;
    const mine = out.filter((r) => r.runId === first).map((r) => (r.data as { chunk: string }).chunk).join('');
    const later = out.filter((r) => r.runId !== first).map((r) => (r.data as { chunk: string }).chunk).join('');
    expect(mine).toBe('visible [hidden: text that looked like a key]'); // not lost, and written under the run that had it (p29a A11: the key start is hidden, not written)
    expect(later).toBe('next\n');                           // not 'sk-tnext'
  }, 60_000);
});
