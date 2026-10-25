// M3 fix round 2, N8: the key of an own playbook's track (`<step>#own`) is never shown. `reins run` prints the playbook's step, the USD card names it, and
// the helper that does it is the one `shownStep`, which reads the suffix from the playbook mod.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '@reins/core';
import { startRunCli } from '../src/run-cli.js';
import { openStore } from '../src/store.js';
const OWN_SUFFIX = '#own'; // the playbook mod's own key ending: the helper reads only the shape `#<lowercase word>`, so the test writes the text itself
import { shownStep } from '../src/trackKey.js';
import { usePack } from './pack-helper.js';

usePack();

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const FRONT = '---\nreins: 1\nname: w\nbudget: { turns: 40, minutes: 20, usd: 4.00 }\nalways: []\n---\n\n';
const REVIEW = '---\nreins: 1\nblock: b\n---\n\n## phase review\n> Review {{target}}.\n\n## phase findings\n> Write the findings.\n';
const engine = (cost: number): Engine => ({
  id: 'test',
  probe: async () => ({ installed: true, loggedIn: true, capabilities: { midTurnSteer: 'hook', preToolDeny: true, resume: true }, problems: [] }),
  open: async () => ({
    sessionId: 'sess',
    turn: async () => ({ text: 'ok\nREINS: done', events: [], cost }),
    interrupt: async () => {},
    events: { async *[Symbol.asyncIterator]() {} },
    close: async () => {},
  }),
});
async function run(flow: string, cost: number, typed = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-n8-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'blocks'));
  fs.writeFileSync(path.join(dir, 'blocks', 'review-pass.reins.md'), REVIEW);
  const file = path.join(dir, 'flow.reins.md');
  fs.writeFileSync(file, FRONT + flow + '\n');
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.setEncoding('utf8');
  output.on('data', (d: string) => { out += d; });
  const h = startRunCli({ file, cwd: dir, input, output, store: openStore(':memory:'), makeEngine: () => engine(cost), yes: true });
  if (typed) {
    for (let i = 0; i < 200 && !out.includes('/ stop'); i++) await new Promise((r) => setTimeout(r, 25));
    input.write(typed);
  }
  await h.done;
  return out;
}

describe('N8: the user never reads the suffix of the track key', () => {
  it('the helper strips the suffix once, at the end, and nothing else', () => {
    expect(shownStep(`playbook-1${OWN_SUFFIX}`)).toBe('playbook-1');
    expect(shownStep(`pb/playbook-1${OWN_SUFFIX}`)).toBe('pb/playbook-1');
    expect(shownStep('a')).toBe('a');
    expect(shownStep(`${OWN_SUFFIX}x`)).toBe(`${OWN_SUFFIX}x`);
    expect(shownStep(`x${OWN_SUFFIX}${OWN_SUFFIX}`)).toBe(`x${OWN_SUFFIX}`);
    expect(shownStep('x#own#own')).toBe('x#own');            // once, at the end
    expect(shownStep('x#Own')).toBe('x#Own');                // only a lowercase word
    expect(shownStep('x#')).toBe('x#');
    expect(shownStep('__proto__#own')).toBe('__proto__');
  });
  it('`reins run` prints the playbook step for the track lines', async () => {
    const out = await run('## playbook review-pass\ninput: target = a\nsession: own\n\n## end', 0.01);
    expect(out).toContain('track playbook-1 started (Playbook review-pass)');
    expect(out).toMatch(/track playbook-1 ended \(Playbook review-pass\)/);
    expect(out).not.toContain(OWN_SUFFIX);
  });
  it('the USD card and its question name the playbook step', async () => {
    const out = await run('## playbook review-pass\ninput: target = a\nsession: own\nusd: 0.01\n\n## end', 0.05, 'stop\n');
    expect(out).toMatch(/block playbook-1 used its \$/);
    expect(out).not.toContain(OWN_SUFFIX);
  });
});
