// M3 Task 9 (group F): `reins run` on a file with a fork prints the fork's own lines (the block's `print` table), the branches' start and end lines (core's), and the
// receipt count; a branch's approval question is titled with the branch; a Stop answers every open branch. An engine of its own, as the toy-split terminal tests use.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { Decision, Engine, ToolRequest } from '@reins/core';
import { startRunCli } from '../src/run-cli.js';
import { openStore } from '../src/store.js';
import { until } from './helpers.js';
import { usePack } from './pack-helper.js';

usePack();

const FRONT = '---\nreins: 1\nname: w\nbudget: { turns: 20, minutes: 20 }\nalways: []\n---\n\n';
const A = '## phase Alpha\nid: a\n> work-A\n\n## end\n\n';
const B = '## phase Beta\nid: b\n> work-B\n\n## end\n\n';
const A_GATE = '## phase Alpha\nid: a\n> work-A\n\n## gate\nid: ga\nuntil: you approve\n\n## end\n\n';
const B_GATE = '## phase Beta\nid: b\n> work-B\n\n## gate\nid: gb\nuntil: you approve\n\n## end\n\n';
const body = (a: string, b: string, fork = '## fork\nnext: a\nnext: b\n') => `${FRONT}${fork}\n## phase main\n> main-after\n\n## end\n\n${a}${b}`;
const engine: Engine = {
  id: 'test',
  probe: async () => ({ installed: true, loggedIn: true, capabilities: { midTurnSteer: 'hook', preToolDeny: true, resume: true }, problems: [] }),
  open: async () => ({
    sessionId: 'sess',
    turn: async () => ({ text: 'ok\nREINS: done', events: [], cost: 0.01 }),
    interrupt: async () => {},
    events: { async *[Symbol.asyncIterator]() {} },
    close: async () => {},
  }),
};

const started: Array<{ h: ReturnType<typeof startRunCli>; cleanup: () => void }> = [];
function terminal(text: string, sub: (onApprove: (r: ToolRequest) => Promise<Decision>) => Engine = () => engine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-f-cli-'));
  const file = path.join(dir, 'w.reins.md');
  fs.writeFileSync(file, text);
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.setEncoding('utf8');
  output.on('data', (d: string) => { out += d; });
  const h = startRunCli({ file, cwd: dir, input, output, store: openStore(':memory:'), makeEngine: () => engine, subagentEngine: (_s, io) => ({ engine: sub(io.onApprove) }) });
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  const d = { h, text: () => out, type: (l: string) => input.write(l + '\n'), finish: async () => { try { return await h.done; } finally { cleanup(); } }, cleanup };
  started.push(d);
  return d;
}
afterEach(async () => {
  for (const d of started.splice(0)) {
    d.h.sigint(); d.h.sigint();
    await Promise.race([d.h.done.catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    d.cleanup();
  }
});
const gatesWaiting = (t: string) => [...t.matchAll(/gate (g[ab]): until you approve/g)].map((m) => m[1]!);

describe('reins run on a file with a fork', () => {
  it('prints the fork\'s lines around the branches\' lines, and the count in the receipt', async () => {
    const d = terminal(body(A, B));
    const r = await d.finish();
    expect(r.exitCode).toBe(0);
    const t = d.text();
    const at = (s: string) => t.indexOf(s);
    expect(at('· fork fork-1: 2 branches started')).toBeGreaterThanOrEqual(0);
    expect(at('track a started (Branch Alpha)')).toBeGreaterThanOrEqual(0);
    expect(at('track b started (Branch Beta)')).toBeGreaterThanOrEqual(0);
    expect(t).toMatch(/track a ended \(Branch Alpha\) \$0\.0100/);
    expect(t).toMatch(/track b ended \(Branch Beta\) \$0\.0100/);
    expect(at('· fork fork-1: every branch finished')).toBeGreaterThan(at('track b ended'));
    expect(at('· fork fork-1: every branch finished')).toBeGreaterThan(at('track a ended'));
    const lines = t.split('\n');
    expect(lines).toContain('forks 1');
  });

  it('a fork with one branch says "1 branch", not "1 branches"', async () => {
    const d = terminal(body(A, '', '## fork\nnext: a\n'));
    await d.finish();
    expect(d.text()).toContain('· fork fork-1: 1 branch started');
    expect(d.text()).not.toContain('1 branches');
  });

  it('two branch gates ask at once, each titled with its branch; the first typed line answers the first; the fork finishes after both', async () => {
    const d = terminal(body(A_GATE, B_GATE));
    await until(() => gatesWaiting(d.text()).length === 2 && (d.text().match(/\[Branch (Alpha|Beta)\] approve \/ changes <note> \/ stop/g) ?? []).length === 2, 30_000);
    expect(d.text()).not.toContain('every branch finished');
    d.type('approve');
    await until(() => (d.text().match(/ended \(Branch/g) ?? []).length === 1, 30_000);
    expect(d.text()).not.toContain('every branch finished');   // the other branch still waits, so the fork waits
    d.type('approve');
    const r = await d.finish();
    expect(r.exitCode).toBe(0);
    expect(d.text()).toContain('· fork fork-1: every branch finished');
  });

  it('Stop answers every waiting branch and the run ends without the fork finishing', async () => {
    const d = terminal(body(A_GATE, B_GATE));
    await until(() => (d.text().match(/\[Branch (Alpha|Beta)\] approve/g) ?? []).length === 2, 30_000);
    d.type('stop');
    const r = await Promise.race([d.finish(), new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 5000))]);
    expect(r).not.toBe('timeout');
    expect(d.text()).not.toContain('every branch finished');
  });
});
