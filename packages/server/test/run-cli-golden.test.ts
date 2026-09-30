// The terminal bytes of `reins run`, recorded before the drive.ts move (plan 15d 3b.8, last unit test).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { startRunCli } from '../src/run-cli.js';
import { openStore } from '../src/store.js';
import { claudeEngine } from '../src/claude/engine.js';
import { FAKE_CLAUDE, fakeSetup, type FakeTurn } from './helpers.js';

const GOLDEN = path.join(__dirname, 'golden-3b');

function normalise(text: string, cwd: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split(cwd).join('<CWD>')
    .split(cwd.replace(/\\/g, '/')).join('<CWD>')
    .replace(/<CWD>[^\s:,\]]*/g, (m) => m.replace(/\\/g, '/')) // a Windows path prints with \, Linux and macOS with /
    .replace(/(run(?: id)?) [0-9a-f]{8}\b/g, '$1 <ID>')
    .replace(/--resume [0-9a-f]{8}\b/g, '--resume <ID>')
    .replace(/· \d+ s · \$\d+\.\d{4}/g, '· <N> s · $<COST>');
}

function golden(name: string, text: string) {
  const file = path.join(GOLDEN, name);
  if (process.env.REINS_RECORD_3B === '1') {
    fs.mkdirSync(GOLDEN, { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  expect(fs.existsSync(file), `missing golden ${name}`).toBe(true);
  expect(text).toBe(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
}

/** Run a workflow through `reins run`, typing each answer the moment its prompt has been printed. */
async function play(name: string, workflow: string, script: FakeTurn[], o: { yes?: boolean; answers?: Array<[RegExp, string]> }) {
  const f = fakeSetup(script);
  const file = path.join(f.dir, 'wf.reins.md');
  fs.writeFileSync(file, workflow);
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding('utf8');
  let text = '';
  let seen = 0;
  const answers = [...(o.answers ?? [])];
  output.on('data', (d: string) => {
    text += d;
    for (;;) {
      const next = answers[0];
      const m = next && next[0].exec(text.slice(seen));
      if (!next || !m) break;
      seen += m.index + m[0].length;
      answers.shift();
      input.write(next[1] + '\n');
    }
  });
  const store = openStore(':memory:');
  const h = startRunCli({
    file, cwd: f.dir, input, output, store, ...(o.yes ? { yes: true } : {}),
    makeEngine: ({ onApprove, onLive }) => claudeEngine({ bin: FAKE_CLAUDE, onApprove, onLive }),
  });
  const res = await h.done;
  expect(answers, 'every scripted answer was used').toEqual([]);
  golden(`${name}.txt`, normalise(text, f.dir));
  store.close();
  return res;
}

const head = (name: string, extra: string[] = []) => ['---', 'reins: 1', `name: ${name}`, ...extra, 'budget: { turns: 30, minutes: 30 }', 'always: []', '---', ''];

describe('reins run terminal output is recorded before the drive.ts move', () => {
  it('--yes: command output, pass and fail lines, a gate, a judge', async () => {
    const wf = [
      ...head('golden-yes', ['test: echo tests-ok']),
      '## phase plan', 'mode: read-only', '> Plan it.', '',
      '## run `echo hello`', '',
      '## run `exit 3`', '',
      '## gate', 'until: you approve', '',
      '## gate', 'until: llm says "looks fine"', '',
      '## repeat', 'until: tests pass', 'max: 2', '', '### phase fix', '> Fix it.', '',
    ].join('\n');
    const res = await play('yes', wf, [
      { fixture: 'claude-2.1.281-turns.jsonl', turn: 0 },
      { fixture: 'claude-2.1.281-turns.jsonl', turn: 1 },
    ], { yes: true });
    expect(res.status).toBe('done');
  });

  it('typed answers: blocked, tool y and n, gate words, judge, budget', async () => {
    const wf = [
      ...head('golden-answers', ['test: exit 1']),
      '## phase blocked', '> Try.', '',
      '## phase edit-one', '> Edit.', '',
      '## phase edit-two', '> Edit again.', '',
      '## gate', 'until: you approve', '',
      '## gate', 'until: llm says "ok"', '',
      '## repeat', 'until: tests pass', 'max: 1', '', '### phase fix', '> Fix.', '',
    ].join('\n');
    const res = await play('answers', wf, [
      { fixture: 'claude-2.1.281-turns.jsonl', turn: 0, text: 'REINS: blocked: need input' },
      { fixture: 'claude-2.1.281-turns.jsonl', turn: 0 },
      { fixture: 'claude-2.1.281-approval-allow-hold.jsonl', approve: true },
      { fixture: 'claude-2.1.281-approval-deny.jsonl', approve: true },
      { fixture: 'claude-2.1.281-turns.jsonl', turn: 1 },
    ], {
      answers: [
        [/resume \[note\] \/ stop\n/, 'resume carry on'],
        [/\? Allow Edit[^\n]*\n/, 'y'],
        [/\? Allow Edit[^\n]*\n/, 'n not now'],
        [/approve \/ changes <note> \/ stop\n/, 'blah'],
        [/Type approve, changes <note>, or stop\.\n/, 'changes tweak it'],
        [/approve \/ changes <note> \/ stop\n/, 'approve'],
        [/\? You judge[^\n]*\n[\s\S]*?y \/ n\n/, 'n'],
        [/approve \/ changes <note> \/ stop\n/, 'approve'],
        [/allow <n> more \/ stop\n/, 'allow 1 more'],
        [/allow <n> more \/ stop\n/, 'stop'],
      ],
    });
    expect(res.status).toBe('stopped');
  });
});
