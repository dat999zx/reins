// M3 Task 10 (playbook): the PIN, recorded at HEAD before any playbook code. A workflow without a playbook must parse, print, validate and compile exactly as before:
// the generic "a step id starts twice" check, the compile helpers and the block resolver add nothing for it. Compared with `m3-task-p-pin.expected.json`.
// To record again (only ever at a commit where the answer is known to be right): `PIN_WRITE=1 npx vitest run --project server packages/server/test/m3-task-p-pin.test.ts`.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileProgram, parseWorkflow, printWorkflow, validate } from '@reins/core';
import { loadWorkflowText } from '../src/run-cli.js';
import { usePack } from './pack-helper.js';

usePack();

const EXPECTED = new URL('./m3-task-p-pin.expected.json', import.meta.url);
const EX = path.resolve(__dirname, '../../../examples');
const head = (name: string) => `---\nreins: 1\nname: ${name}\nbudget: { turns: 20, minutes: 9, usd: 4.00 }\nalways: []\n---\n\n`;

const CASES: Record<string, string> = {
  bugFix: fs.readFileSync(path.join(EX, 'bug-fix.reins.md'), 'utf8'),
  safeRefactor: fs.readFileSync(path.join(EX, 'safe-refactor.reins.md'), 'utf8'),
  slashIds: head('slash') + '## phase a\nid: x/y\n> a\n\n## phase b\nid: x/z\nnext: x/y (max 2)\n> b\n\n## end\n',
  dupId: head('dup') + '## phase a\nid: same\n> a\n\n## phase b\nid: same\n> b\n',
  badLinks: head('links') + '## phase a\nnext: nowhere\n> a\n\n## phase b\nnext: a\n> b\n',
  loops: head('loops') + '## repeat\nuntil: you approve\nmax: 3\n\n### phase work\n> work\n\n### run `npm test`\n\n## if\nuntil: tests pass\n\n### phase yes\n> y\n\n### else\n\n### phase no\n> n\n\n## verify\nagainst: work\n\n## end\n',
  blockFile: '---\nreins: 1\nblock: tiny\n---\n\n## phase one\n> one\n\n## gate\nuntil: you approve\n',
};

function record() {
  const out: Record<string, unknown> = {};
  for (const [name, text] of Object.entries(CASES)) {
    const p = parseWorkflow(text);
    out[name] = {
      parse: p.diagnostics,
      printed: p.workflow ? printWorkflow(p.workflow) : undefined,
      validate: p.workflow ? validate(p.workflow) : undefined,
      program: p.workflow ? compileProgram(p.workflow) : undefined,
      loaded: loadWorkflowText(text, path.join(EX, 'x.reins.md')).diagnostics,
    };
  }
  return JSON.parse(JSON.stringify(out));
}

describe('M3 Task 10 pin: workflows without a playbook come out as they did at HEAD', () => {
  it('parse, print, validate and compile of seven workflows', () => {
    const got = record();
    if (process.env.PIN_WRITE === '1') fs.writeFileSync(EXPECTED, JSON.stringify(got, null, 2) + '\n');
    expect(got).toEqual(JSON.parse(fs.readFileSync(EXPECTED, 'utf8')));
  });
});
