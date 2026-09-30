// The folder half of trust (plan 15d 3b.4): which files, one hash, the 4 KB detail.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWorkflow, type Workflow } from '@reins/core';
import { FOLDER_PATH, commandsOf, folderHash, hashCommands } from '../src/trust.js';

const dirs: string[] = [];
const folder = (files: Record<string, string> = {}) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-trust-'));
  dirs.push(d);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), text);
  }
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('folderHash (3b.4)', () => {
  it('is undefined when the folder has none of the three files, and the path key is .claude/', () => {
    expect(folderHash(folder({ 'src/a.ts': 'x' }))).toBeUndefined();
    expect(FOLDER_PATH).toBe('.claude/');
  });

  it('covers settings.json, settings.local.json and .mcp.json, and changes when any one changes', () => {
    const files = { '.claude/settings.json': 'a', '.claude/settings.local.json': 'b', '.mcp.json': 'c' };
    const base = folderHash(folder(files))!.hash;
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(folderHash(folder(files))!.hash).toBe(base);
    for (const f of Object.keys(files)) {
      expect(folderHash(folder({ ...files, [f]: 'changed' }))!.hash, f).not.toBe(base);
    }
    expect(folderHash(folder({ '.claude/settings.json': 'a' }))!.hash).not.toBe(base);
  });

  it('the detail lists each file with its content cut to 4 KB, and the hash covers all of it', () => {
    const big = 'x'.repeat(5000);
    const f = folderHash(folder({ '.mcp.json': big }))!;
    expect(f.detail).toBe(`.mcp.json\n${'x'.repeat(4096)}`);
    expect(f.hash).not.toBe(folderHash(folder({ '.mcp.json': big + 'y' }))!.hash);
  });
});

const wf = (body: string, front = '') => parseWorkflow(`---\nreins: 1\nname: t\n${front}---\n\n${body}\n`).workflow!;
const block = (body: string) => parseWorkflow(`---\nreins: 1\nblock: rp\n---\n\n${body}\n`).workflow!;
const none = () => undefined;
const hashOf = (w: Workflow, r: (n: string) => Workflow | undefined = none) => hashCommands(commandsOf(w, r));

describe('workflow trust hash (3b.6)', () => {
  it('lists RUN commands, the atoms judged by a command (gate, repeat, autos), then the test command; not the other atoms', () => {
    const w = wf(
      '## run `make build`\n\n## gate\nuntil: `lint.sh` passes\n\n## gate\nuntil: you approve\n\n## repeat\nuntil: tests pass and `npm run typecheck` passes\nmax: 3\n\n### run `npm test`\n\n### phase fix\n> fix it',
      'test: npm run unit\n',
    );
    const cmds = commandsOf(w, none);
    expect(cmds[0]).toBe('make build');
    expect(cmds).toContain('`lint.sh` passes');
    expect(cmds).toContain('`npm run typecheck` passes');
    expect(cmds).toContain('tests pass');
    expect(cmds).toContain('npm test');
    expect(cmds.at(-1)).toBe('npm run unit');
    expect(cmds).not.toContain('you approve');
    expect(commandsOf(wf('## phase a\n> x'), none)).toEqual(['npm test']);
    const autos = [{ id: 'a', cond: { t: 'cmd', cmd: 'auto.sh' }, card: { kind: 'nudge', text: 'x' } }] as unknown as Workflow['autos'];
    expect(commandsOf({ ...wf('## phase a\n> x'), autos }, none)).toEqual(['`auto.sh` passes', 'npm test']);
  });

  it('changes when a command changes, including one inside a used block, and not when a prompt changes', () => {
    const main = wf('## use rp\n\n## phase go\n> first prompt');
    const blk = (cmd: string) => (n: string) => (n === 'rp' ? block(`## run \`${cmd}\``) : undefined);
    expect(hashOf(main, blk('echo one'))).toBe(hashOf(main, blk('echo one')));
    expect(hashOf(main, blk('echo two'))).not.toBe(hashOf(main, blk('echo one')));
    expect(hashOf(wf('## phase go\n> other prompt'))).toBe(hashOf(wf('## phase go\n> first prompt')));
    expect(hashOf(wf('## run `a`'))).not.toBe(hashOf(wf('## run `a`', 'test: npm run unit\n')));
    expect(hashOf(wf('## run `a`'))).not.toBe(hashOf(wf('## run `b`')));
  });

  it('hashCommands is a 64-hex sha256 and keeps command boundaries', () => {
    expect(hashCommands(['a'])).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCommands(['a', 'b'])).not.toBe(hashCommands(['ab']));
  });
});
