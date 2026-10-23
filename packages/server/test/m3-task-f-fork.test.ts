// M3 Task 9 (group F): the `fork` block of the default pack, written down as files. The examples of spec 4.1 are workflow files here; the tests parse them, print them
// back byte for byte, validate them (every word of spec 4.3), compile them, and read the manifest. The hostile cases come first: a fork with no branch, one branch, a
// branch that does not exist, a branch that jumps out, a fork in a branch, a model in a branch, a fork in a loop. The runs are in `m3-task-f-run.test.ts`.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileProgram, parseWorkflow, printWorkflow, register, validate, type Diagnostic } from '@reins/core';
import { split } from '../../core/test/fixtures/split.js';
import { usePack } from './pack-helper.js';

usePack();
// the toy `split` starts tracks too: it lets a test put a track INSIDE a branch (the pack has no other block that does, besides the fork itself)
let offSplit: (() => void) | undefined;
beforeAll(() => { offSplit = register(split); });
afterAll(() => { offSplit?.(); });

const head = (name = 'f', budget = '{ turns: 40, minutes: 9 }') => `---\nreins: 1\nname: ${name}\nbudget: ${budget}\nalways: []\n---\n\n`;

/** The file of spec 4.1, with the one line the printer writes differently: `## run npm test` prints back as ``## run `npm test` `` (see SPEC41_AS_WRITTEN). */
export const SPEC41 = `${head('spec')}## phase Plan
> Plan the work.

## fork
next: research-api
next: research-db

## phase Build
> Build it from both research results.

## end

## subagent API research
id: research-api
model: claude-haiku-5-5
usd: 0.50
> Read the API docs.

## end

## phase DB research
id: research-db
mode: read-only
> Read the schema.

## run \`npm test\`
`;
/** The spec's own text: the command without backticks. It parses to the same workflow; only the print differs, by the backticks. */
const SPEC41_AS_WRITTEN = SPEC41.replace('## run `npm test`', '## run npm test');

const parse = (text: string) => {
  const p = parseWorkflow(text);
  expect(p.diagnostics, 'the file must parse').toEqual([]);
  return p.workflow!;
};
/** `severity: message` for every diagnostic of the file, in order. */
const diags = (text: string): string[] => validate(parse(text)).map((d: Diagnostic) => `${d.severity}: ${d.message}`);
const errors = (text: string) => diags(text).filter((d) => d.startsWith('error'));

describe('spec 4.1: the file format', () => {
  it('parses, prints back the same bytes, and compiles to one FORK with both targets in wire order', () => {
    const w = parse(SPEC41);
    expect(w.steps.map((s) => [s.kind, s.id])).toEqual([
      ['phase', 'plan'], ['fork', 'fork-1'], ['phase', 'build'], ['end', 'end-1'], ['subagent', 'research-api'], ['end', 'end-2'], ['phase', 'research-db'], ['run', 'run-1'],
    ]);
    expect(w.steps[1]!.links).toEqual([expect.objectContaining({ kind: 'next', to: 'research-api' }), expect.objectContaining({ kind: 'next', to: 'research-db' })]);
    expect(printWorkflow(w)).toBe(SPEC41);
    expect(parseWorkflow(SPEC41_AS_WRITTEN).workflow).toEqual(parseWorkflow(SPEC41).workflow);   // the spec's line without backticks is the same workflow
    expect(printWorkflow(parse(SPEC41_AS_WRITTEN))).toBe(SPEC41);
    const program = compileProgram(w);
    const at = (step: string) => program.findIndex((i) => 'step' in i && i.step === step);
    const forks = program.filter((i) => i.op === 'FORK');
    expect(forks).toEqual([{ op: 'FORK', step: 'fork-1', top: 1, targets: [at('research-api'), at('research-db')] }]);
    expect(at('research-api')).toBeGreaterThan(at('build'));
  });

  it('has no error; the one warning is that both branches can write (the subagent and the command)', () => {
    expect(diags(SPEC41)).toEqual(['warning: branches `research-api` and `research-db` can both edit files in the same folder at once']);
  });

  it('a heading word is a title, and the wires keep their order through a print', () => {
    const text = `${head()}## fork\nnext: b\nnext: a\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## end\n\n## phase b\n> b\n\n## end\n`;
    const w = parse(text);
    expect(w.steps[0]!.links.map((l) => l.to)).toEqual(['b', 'a']);
    expect(printWorkflow(w)).toBe(text);
    const program = compileProgram(w);
    const at = (step: string) => program.findIndex((i) => 'step' in i && i.step === step);
    expect(program.find((i) => i.op === 'FORK')).toMatchObject({ targets: [at('b'), at('a')] });
  });

  it('a file with a `next:` line that is not on a fork keeps one wire; a second one is the old error', () => {
    const text = `${head()}## phase a\nnext: c\n> a\n\n## phase b\n> b\n\n## phase c\n> c\n`;
    expect(errors(text)).toEqual([]);
    expect(errors(`${head()}## phase a\nnext: c\nnext: b\n> a\n\n## phase b\n> b\n\n## phase c\n> c\n`)).toEqual(['error: a step can have only one `next` link']);
  });
});

describe('spec 4.3: the words', () => {
  const three = (fork: string, rest = '') => `${head()}${fork}\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## end\n\n## phase b\n> b\n\n## end\n${rest}`;

  it('F2: a fork with no branch is an error, in the words of the table', () => {
    expect(diags(`${head()}## fork\n\n## phase main\n> m\n\n## end\n`)).toContain('error: fork `fork-1` has no branches; drag a wire from it to the first block of each branch');
  });

  it('F3: a fork with one branch is a warning, and the file still runs', () => {
    const text = three('## fork\nnext: a\n');
    expect(diags(text)).toEqual(['warning: fork `fork-1` has one branch: it runs nothing in parallel', expect.stringContaining('`b` is never reached')]);
  });

  it('F4: two wires to the same block is an error, said once', () => {
    expect(errors(three('## fork\nnext: a\nnext: a\nnext: b\n'))).toEqual(['error: fork `fork-1` has two wires to `a`']);
    expect(errors(three('## fork\nnext: a\nnext: a\nnext: a\nnext: b\nnext: b\n'))).toEqual(['error: fork `fork-1` has two wires to `a`', 'error: fork `fork-1` has two wires to `b`']);
  });

  it('a wire to a block that does not exist is the core error, and the file does not compile into a run that starts it', () => {
    const text = three('## fork\nnext: a\nnext: ghost\n');
    expect(errors(text).join('\n')).toMatch(/ghost/);
    const program = compileProgram(parse(text));
    expect(program.find((i) => i.op === 'FORK')).toMatchObject({ targets: [expect.any(Number)] });   // only the branch that exists
  });

  it('a fork with a prompt or a card: the warning, as the model block says it', () => {
    const words = 'warning: a fork sends no turn; its cards and prompt do nothing';
    expect(diags(three('## fork\nnext: a\nnext: b\n> hello\n')).filter((d) => d === words)).toEqual([words]);
    expect(diags(three('## fork\nnext: a\nnext: b\n')).filter((d) => d === words)).toEqual([]);
  });

  it('F5 (R1): a branch that is also in the stack, F6 (R2): a block in two branches, F7 (R3): a branch that jumps out of the fork', () => {
    // R1: `main` is the block under the fork, and a wire points at it
    expect(errors(three('## fork\nnext: main\nnext: a\n'))).toEqual([
      expect.stringContaining('`main` starts a branch of `fork-1`, so only `fork-1` may start it: put it behind the end, and let nothing else lead into it'),
    ]);
    // R2: a and b both go on into c, with no end under them
    const shared = `${head()}## fork\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n## phase b\nid: b\n> b\n\n## phase c\n> c\n\n## end\n`;
    expect(errors(shared).join('\n')).toMatch(/is in branch `a` and branch `b`; put an end under each branch/);
    // R3: a branch ends with a link back to the block under the fork. A branch lies behind the stack, so such a link is a backward link: without a `max` it is the old error first.
    const out = (link: string) => `${head()}## fork\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n${link}\n\n## end\n\n## phase b\n> b\n\n## end\n`;
    expect(errors(out('next: main'))).toEqual(['error: Backward link to "main" requires max']);
    expect(errors(out('next: main (max 2)'))).toEqual(['error: branch `a` of `fork-1` leads back into the stack at `main`; end the branch instead']);
    // and with an on-fail link of a command in the branch
    const failOut = `${head()}## fork\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## run \`x\`\nid: a\non-fail: main (max 2)\n\n## end\n\n## phase b\n> b\n\n## end\n`;
    expect(errors(failOut)).toEqual(['error: branch `a` of `fork-1` leads back into the stack at `main`; end the branch instead']);
    // a branch that jumps to a block of the other branch shares it (R2), whichever way the link points
    const across = `${head()}## fork\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\nnext: b2\n\n## end\n\n## phase b\n> b\n\n## phase b2\n> b2\n\n## end\n`;
    expect(errors(across).join('\n')).toMatch(/`b2` is in branch `a` and branch `b`; put an end under each branch/);
  });

  it('F9: a fork inside a branch is an error; the wire of the inner fork still belongs to it', () => {
    const inner = `${head()}## fork\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## fork\nid: inner\nnext: c\nnext: d\n\n## end\n\n## phase b\n> b\n\n## end\n\n## phase c\n> c\n\n## end\n\n## phase d\n> d\n\n## end\n`;
    // `a` is not a block here: the inner fork is the first block of branch `a`'s place, so name it
    const text = inner.replace('next: a\n', 'next: inner\n');
    expect(errors(text)).toEqual(['error: fork `inner` must be in the main stack, not inside a branch or a playbook']);
  });

  it('a fork in a loop is allowed: no error, no warning about the loop', () => {
    const text = `${head()}## repeat\nuntil: agent says done\nmax: 2\n\n### fork\nnext: a\nnext: b\n\n## phase after\n> after\n\n## end\n\n## phase a\n> a\n\n## end\n\n## phase b\n> b\n\n## end\n`;
    expect(errors(text)).toEqual([]);
  });

  it('F10: a model block in a branch is an error, also deeper in the branch; before the fork it is fine', () => {
    const inBranch = three('## fork\nnext: a\nnext: b\n').replace('## phase a\n> a\n', '## model claude-haiku-5-5\nid: m1\n\n## phase a\n> a\n').replace('next: a\n', 'next: m1\n');
    expect(errors(inBranch)).toEqual(['error: a model block cannot be inside a branch; put it before the fork']);
    const deeper = three('## fork\nnext: a\nnext: b\n').replace('## phase a\n> a\n', '## phase a\n> a\n\n## model claude-haiku-5-5\nid: m2\n');
    expect(errors(deeper)).toEqual(['error: a model block cannot be inside a branch; put it before the fork']);
    const before = `${head()}## model claude-haiku-5-5\n\n${three('## fork\nnext: a\nnext: b\n').slice(head().length)}`;
    expect(errors(before)).toEqual([]);
  });

  it('F10 reaches a model block in a track that a branch starts itself (here by the toy split), not only in the branch\'s own steps', () => {
    const text = `${head()}## fork\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## split\nid: a\nnext: deep\n\n## end\n\n## phase b\n> b\n\n## end\n\n## model claude-haiku-5-5\nid: deep\n\n## end\n`;
    expect(errors(text)).toEqual(['error: a model block cannot be inside a branch; put it before the fork']);
    // the same split with a phase there is clean
    expect(errors(text.replace('## model claude-haiku-5-5\nid: deep', '## phase deep\n> d'))).toEqual([]);
  });

  it('F11: a verify in one branch against a block in another is a warning; in the same branch, or on the main line, it is not', () => {
    const branches = (verify: string, second = '') => `${head()}## fork\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n## phase a\n> a\n\n${verify}## end\n\n## phase b\n> b\n\n${second}## end\n`;
    expect(diags(branches('## verify\nid: v\nagainst: b\n\n'))).toContain('warning: `v` checks `b`, which runs in another branch and may not have finished');
    expect(diags(branches('## verify\nid: v\nagainst: a\n\n')).filter((d) => d.includes('another branch'))).toEqual([]);
    expect(diags(branches('', '')).filter((d) => d.includes('another branch'))).toEqual([]);
    // the main line runs after every branch ended
    const main = `${head()}## fork\nnext: a\nnext: b\n\n## verify\nid: v\nagainst: b\n\n## end\n\n## phase a\n> a\n\n## end\n\n## phase b\n> b\n\n## end\n`;
    expect(diags(main).filter((d) => d.includes('another branch'))).toEqual([]);
    // and the other way: a branch checks the main line
    const toMain = `${head()}## phase first\n> first\n\n## fork\nnext: a\nnext: b\n\n## end\n\n## verify\nid: a\nagainst: first\n\n## end\n\n## phase b\n> b\n\n## end\n`;
    expect(diags(toMain).filter((d) => d.includes('another branch'))).toEqual([]);
  });

  it('W1: two branches that can write warn once; read-only branches, or one writer, do not', () => {
    const pair = (a: string, b: string) => `${head()}## fork\nnext: a\nnext: b\n\n## phase main\n> m\n\n## end\n\n${a}## end\n\n${b}## end\n`;
    const write = (id: string) => `## phase ${id}\nid: ${id}\n> w\n\n`;
    const ro = (id: string) => `## phase ${id}\nid: ${id}\nmode: read-only\n> r\n\n`;
    const cmd = (id: string) => `## run \`ls\`\nid: ${id}\n\n`;
    const sub = (id: string, mode = '') => `## subagent ${id}\nid: ${id}\n${mode}> s\n\n`;
    const w1 = (t: string) => diags(t).filter((d) => d.includes('edit files'));
    const words = 'warning: branches `a` and `b` can both edit files in the same folder at once';
    expect(w1(pair(write('a'), write('b')))).toEqual([words]);
    expect(w1(pair(ro('a'), write('b')))).toEqual([]);
    expect(w1(pair(ro('a'), ro('b')))).toEqual([]);
    expect(w1(pair(ro('a'), cmd('b')))).toEqual([]);          // one writer is not a clash
    expect(w1(pair(cmd('a'), cmd('b')))).toEqual([words]);    // a command counts as a write
    expect(w1(pair(sub('a'), sub('b')))).toEqual([words]);
    expect(w1(pair(sub('a', 'mode: read-only\n'), sub('b')))).toEqual([]);
    expect(w1(pair(ro('a') + cmd('a2'), write('b')))).toEqual([words]);   // a command later in the branch counts too
    // three writers: still one warning, about the first two
    const three3 = `${head()}## fork\nnext: a\nnext: b\nnext: c\n\n## phase main\n> m\n\n## end\n\n${write('a')}## end\n\n${write('b')}## end\n\n${write('c')}## end\n`;
    expect(w1(three3)).toEqual([words]);
  });

  it('W2: nothing after the fork gets the branch results', () => {
    const text = `${head()}## fork\nnext: a\nnext: b\n\n## end\n\n## phase a\n> a\n\n## end\n\n## phase b\n> b\n\n## end\n`;
    expect(diags(text)).toContain('warning: nothing after fork `fork-1` gets the branch results');
    expect(diags(three('## fork\nnext: a\nnext: b\n')).filter((d) => d.includes('nothing after'))).toEqual([]);
  });
});

describe('the manifest', () => {
  const mod = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/mods/fork/mod.json'), 'utf8')) as Record<string, any>;
  it('is a pack mod at order 135 that brings the FORK op and its two events', () => {
    expect(mod).toMatchObject({ id: 'fork', kind: 'block', pack: 'default', order: 135, provides: { kinds: ['fork'], ops: ['FORK'], events: ['fork_started', 'fork_done'] } });
    expect(mod.required).toBeUndefined();
    expect(mod.provides.attrs).toBeUndefined();
    expect(mod.view).toMatchObject({ kind: 'fork', order: 135, colour: 'loop', manyNext: true, sub: 'runs {links.length} at once', card: { label: 'fork', section: 'Flow' } });
  });
});
