// M3 Task 10 (playbook), the host half: the real loader (so the block is guarded as a mod's block is), the real file reader of `reins check` and `reins run`
// (`loadWorkflowText`: names, sizes, links, what the parser said about the file), hostile playbook files, and `reins run` on a file with an inline and an own playbook.
// The block itself (compile, validation words, runs) is tested in core's playbook.test.ts with the plain resolver.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { compileProgram, parseWorkflow, type Engine } from '@reins/core';
import { loadWorkflowText, startRunCli } from '../src/run-cli.js';
import { openStore } from '../src/store.js';
import { commandsOf } from '../src/trust.js';
import { usePack } from './pack-helper.js';

usePack();

const FRONT = '---\nreins: 1\nname: w\nbudget: { turns: 40, minutes: 20, usd: 4.00 }\nalways: []\n---\n\n';
const BLOCK = (body: string, extra = '') => `---\nreins: 1\nblock: b\n${extra}---\n\n${body}\n`;
const REVIEW = BLOCK('## phase review\n> Review {{target}}.\n\n## phase findings\n> Write the findings.\n\n## verify\nagainst: findings');

const dirs: string[] = [];
/** A folder with `flow.reins.md`, a `blocks/` folder of the given files, and (outside it) a `secret.reins.md` a path could reach. */
function project(flow: string, blocks: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-pb-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'blocks'));
  for (const [n, t] of Object.entries(blocks)) fs.writeFileSync(path.join(dir, 'blocks', `${n}.reins.md`), t);
  fs.writeFileSync(path.join(dir, 'secret.reins.md'), BLOCK('## phase leak\n> LEAKED'));
  fs.writeFileSync(path.join(dir, 'blocks', '..secret.txt'), 'x');
  const file = path.join(dir, 'flow.reins.md');
  fs.writeFileSync(file, FRONT + flow + '\n');
  return { dir, file, load: () => loadWorkflowText(fs.readFileSync(file, 'utf8'), file) };
}
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const errs = (l: ReturnType<typeof loadWorkflowText>) => l.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);

describe('the file reader refuses what is not a plain playbook file', () => {
  const HOSTILE = ['../secret', '..\\secret', '..', 'a/b', 'a\\b', '/etc/passwd', 'C:\\x\\y', 'C:x', '.hidden', 'CON', 'nul', 'com1.txt', 'x'.repeat(101), 'a b', '', 'a\u0000b', 'a\nb', '~/x', '$HOME', '%TEMP%'];

  it('a path in the name is never read, whatever file it would reach', () => {
    const p = project('## phase one\n> a', { ok: BLOCK('## phase p\n> p') });
    const l = p.load();
    expect(l.resolveBlock('ok')).toBeDefined();
    for (const name of HOSTILE) expect(() => l.resolveBlock(name), JSON.stringify(name)).toThrow(/plain file name/);
    expect(l.resolveBlock('absent')).toBeUndefined();
  });

  it('through the heading: an error with the name made visible, and nothing of the other file in the program', () => {
    for (const name of ['../secret', '..\\secret', 'a/../../secret']) {
      const p = project(`## playbook ${name}`);
      const l = p.load();
      expect(errs(l), name).toEqual([`Playbook "${name}": its name must be one plain file name (letters, digits, - _ and . only), not a path`]);
      expect(JSON.stringify(compileProgram(parseWorkflow(fs.readFileSync(p.file, 'utf8')).workflow!, l.resolveBlock))).not.toContain('LEAKED');
    }
  });

  it('a hidden character in a name is shown as its code point', () => {
    const l = project('## playbook a\u202eb').load();
    expect(errs(l)).toEqual(['Playbook "a<U+202E>b": its name must be one plain file name (letters, digits, - _ and . only), not a path']);
  });

  it('a file over 100 KB, a folder, a link out of the folder: refused in words', () => {
    const big = project('## playbook big', { big: BLOCK('## phase p\n> ' + 'x'.repeat(100_001)) });
    expect(errs(big.load())).toEqual(['Playbook "big": the file is larger than 100 KB']);
    const dirName = project('## playbook folder');
    fs.mkdirSync(path.join(dirName.dir, 'blocks', 'folder.reins.md'));
    expect(errs(dirName.load())).toEqual(['Playbook "folder": it is not a file']);
    const link = project('## playbook link');
    try {
      fs.symlinkSync(path.join(link.dir, 'secret.reins.md'), path.join(link.dir, 'blocks', 'link.reins.md'));
    } catch {
      return;   // no right to make a link here (Windows without developer mode): the rule is the same code path, nothing more to prove
    }
    expect(errs(link.load())).toEqual(['Playbook "link": the file is a link to somewhere outside the blocks folder']);
  });

  it('text that is not a workflow is refused, not read as an empty playbook', () => {
    const p = project('## playbook junk', { junk: '\u0000\u0001\u0002 not a workflow' });
    const e = errs(p.load());
    expect(e).toHaveLength(1);
    expect(e[0]).toMatch(/^Playbook "junk": the file is not a workflow/);
  });

  it('what the parser says about the file is shown on the playbook with its line', () => {
    const p = project('## playbook odd', { odd: BLOCK('## phase p\nbogus: 1\n> p') });
    const l = p.load();
    expect(errs(l)).toEqual(['`odd` line 7: Unknown attribute "bogus"']);
  });

  it('a hidden character in a message from the file is shown as its code point', () => {
    const p = project('## playbook odd', { odd: BLOCK('## phase p\nbo\u202egus: 1\n> p') });
    expect(errs(p.load())).toEqual(['`odd` line 7: Unknown attribute "bo<U+202E>gus"']);
  });
});

describe('a hostile playbook file, through the guarded block', () => {
  it('a file that runs itself, and two that run each other, are refused', () => {
    const self = project('## playbook self', { self: BLOCK('## playbook self') });
    expect(errs(self.load())).toEqual(['`self` line 6: playbook `playbook-1` runs `self`, which runs itself']);
    const ring = project('## playbook ping', { ping: BLOCK('## playbook pong'), pong: BLOCK('## playbook ping') });
    const e = errs(ring.load());
    expect(e).toHaveLength(1);
    expect(e[0]).toContain('runs `ping`, which runs itself');
  });

  it('a chain of twelve files stops at eight levels, in words', () => {
    const blocks: Record<string, string> = {};
    for (let k = 0; k < 12; k++) blocks[`c${k}`] = BLOCK(k < 11 ? `## playbook c${k + 1}` : '## phase tail\n> x');
    const e = errs(project('## playbook c0', blocks).load());
    expect(e.join('\n')).toContain('nested more than 8 levels deep');
  });

  it('a file that fans out to thousands of steps is refused by validate with the reason, and compiles to a visible fault, not a hang', () => {
    const leaf = BLOCK(Array.from({ length: 60 }, (_, k) => `## phase p${k}\n> x`).join('\n\n'));
    const fan = BLOCK(Array.from({ length: 60 }, (_, k) => `## playbook leaf\nid: g${k}`).join('\n\n'));
    const p = project('## playbook fan', { fan, leaf });
    const started = Date.now();
    const l = p.load();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(errs(l).join('\n')).toMatch(/more than 2000 steps/);
  });

  it('an input with a hidden character, a name like __proto__, a placeholder like {{__proto__}}: all refused in words', () => {
    const blocks = { rp: BLOCK('## phase p\n> {{__proto__}} {{target}}') };
    expect(errs(project('## playbook rp\ninput: target = a\u202eb', blocks).load())).toContain('input `target` of `playbook-1` has a hidden character (<U+202E>); it is not used');
    expect(errs(project('## playbook rp\ninput: __proto__ = x; target = a', blocks).load())).toContain('`input:` of `playbook-1` must be name = value pairs separated by ;');
    expect(errs(project('## playbook rp\ninput: target = a', blocks).load())).toEqual(['playbook `playbook-1` gives no input `__proto__`, which `rp` uses']);
    expect(({} as Record<string, unknown>).target).toBeUndefined();
  });

  it('a file with 20,000 nested `not`s, or 300 nested headings, is refused or shown: nothing throws out of check or run', () => {
    const deepCond = project('## playbook deep', { deep: BLOCK('## gate\nuntil: ' + 'not '.repeat(20_000) + 'you approve') });
    const a = deepCond.load();
    expect(a.workflow).toBeUndefined();   // not trusted, not run
    // Which frame overflows depends on the stack in use (the thread pool is deeper than a fork), so the words around the overflow differ: refused, shown once, and named.
    expect(errs(a)).toHaveLength(1);
    expect(errs(a)[0]).toMatch(/Maximum call stack size exceeded/);
    const heads = Array.from({ length: 300 }, (_, k) => `${'#'.repeat(k + 2)} repeat\nmax: 2\nuntil: you approve\n`).join('\n');
    const b = project('## playbook heads', { heads: BLOCK(heads) }).load();
    expect(Array.isArray(b.diagnostics)).toBe(true);   // it came back; what it says is the file's own
  });

  it('a file whose text holds hidden characters in a prompt keeps them in the prompt but a message about it shows them as code points', () => {
    const p = project('## playbook odd', { odd: BLOCK('## phase p\nmode: bad‮mode\n> text') });
    expect(errs(p.load()).join('\n')).toContain('<U+202E>');
  });

  it('the trust list shows an injected second command whole, in the command it was put in', () => {
    const p = project('## playbook rp\ninput: target = a.ts; rm -rf /', { rp: BLOCK('## run `npm test -- {{target}}`') });
    // `;` ends an input, so "rm -rf /" is a malformed second pair, not a command
    expect(errs(p.load())).toEqual(['`input:` of `playbook-1` must be name = value pairs separated by ;']);
    const q = project('## playbook rp\ninput: target = a.ts && rm -rf /', { rp: BLOCK('## run `npm test -- {{target}}`') });
    const l = q.load();
    expect(errs(l)).toEqual([]);
    expect(commandsOf(l.workflow!, l.resolveBlock)).toContain('npm test -- a.ts && rm -rf /');
  });
});

// ---- reins run ----

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
async function run(flow: string, blocks: Record<string, string>) {
  const p = project(flow, blocks);
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.setEncoding('utf8');
  output.on('data', (d: string) => { out += d; });
  const h = startRunCli({ file: p.file, cwd: p.dir, input, output, store: openStore(':memory:'), makeEngine: () => engine, yes: true });
  const r = await h.done;
  return { exit: r.exitCode, out };
}

describe('reins run on a file with a playbook', () => {
  it('an inline playbook prints its lines and counts', async () => {
    const r = await run('## playbook review-pass\ninput: target = src/a.ts\n\n## end', { 'review-pass': REVIEW });
    expect(r.exit).toBe(0);
    expect(r.out).toContain('· playbook playbook-1: review-pass started');
    expect(r.out).toContain('· playbook playbook-1: review-pass finished');
    expect(r.out.split('\n')).toContain('playbooks 1');
    expect(r.out).not.toContain('track playbook-1 started');
  });

  it('an own playbook is a track, titled, and prints the same lines', async () => {
    const r = await run('## playbook review-pass\ninput: target = src/a.ts\nsession: own\nusd: 1.00\noutput: findings\n\n## phase after\n> after\n\n## end', { 'review-pass': REVIEW });
    expect(r.exit).toBe(0);
    expect(r.out).toContain('track playbook-1#own started (Playbook review-pass)');
    expect(r.out).toMatch(/track playbook-1#own ended \(Playbook review-pass\) \$0\.0\d00/);
    expect(r.out).toContain('· playbook playbook-1: review-pass started');
    expect(r.out.split('\n')).toContain('playbooks 1');
  });
});
