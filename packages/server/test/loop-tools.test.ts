import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { receipt, type EngineEvent, type Policy, type RunEventRecord } from '@reins/core';
import { HOME_WORDS, confine, type FsLike } from '../src/loop/paths.js';
import {
  CUT_NOTE, READ_NOTE, RESULT_CAP, TOOLS, classOf, cutText, findTool, shellToolName, toolSpecs, type ToolCtx, type ToolOut,
} from '../src/loop/tools.js';
import { KEY, WIRES, rig, toolResults, types, type Rig, type WireId } from './loop-harness.js';

const NO = 'The user said no.';
/** A host whose user says no to every question. */
const SAYS_NO = { host: { onApprove: async () => ({ behavior: 'deny' as const, message: NO }) } };
const INTERRUPTED = 'Interrupted; the tool did not finish.';
const WRITE_MODE: Policy = { mode: 'write', guards: [], allowShell: true };
const plain = (t: string, max?: number) => (max === undefined ? t : t.slice(0, max));
const win = process.platform === 'win32';

let tmp = '';
let cwd = '';
let outside = '';
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-tools-')));
  cwd = path.join(tmp, 'proj');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(cwd);
  fs.mkdirSync(outside);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const put = (rel: string, text: string | Buffer) => {
  const abs = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
};
const lines = (n: number, width = 0) => Array.from({ length: n }, (_, i) => `line ${i + 1}${'x'.repeat(width)}`).join('\n') + '\n';

function ctxOf(extra: Partial<ToolCtx> = {}): ToolCtx {
  return { cwd, home: path.join(tmp, 'home'), policy: () => WRITE_MODE, signal: new AbortController().signal, redact: plain, redactAll: (t) => t, platform: process.platform, ...extra };
}
/** Confines like the engine does, then runs the tool. The raw value is what the model would pass. */
async function run(name: string, input: Record<string, unknown>, ctx = ctxOf()): Promise<ToolOut> {
  const tool = findTool(name)!;
  const at = confine((input[tool.path?.arg ?? ''] as string | undefined) ?? '.', { cwd: ctx.cwd, home: ctx.home, platform: ctx.platform, ...(ctx.fs ? { fs: ctx.fs } : {}) });
  if (!at.ok) throw new Error(`confine refused: ${at.reason}`);
  return await tool.run!(input, ctx, { abs: at.abs, root: at.root });
}
/** A link to a folder: a symlink on POSIX, a junction on Windows. Undefined, or the reason this environment cannot make one. */
function link(target: string, at: string): string | undefined {
  try {
    fs.symlinkSync(target, at, win ? 'junction' : 'dir');
    return undefined;
  } catch (e) {
    return `links cannot be created here (${(e as Error).message})`;
  }
}

describe('the tool table (4.2)', () => {
  it('lists Claude Code\'s names with their classes, as data', () => {
    expect(TOOLS.map((t) => [t.name, t.class])).toEqual([
      ['Read', 'read'], ['Write', 'write'], ['Edit', 'write'], ['Glob', 'read'], ['Grep', 'read'], ['Bash', 'shell'], ['PowerShell', 'shell'],
    ]);
  });

  it('the model is offered the file tools and this platform\'s shell only', () => {
    expect(toolSpecs('linux').map((t) => t.name)).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']);
    expect(toolSpecs('win32').map((t) => t.name)).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'PowerShell']);
    expect(shellToolName('win32')).toBe('PowerShell');
    expect(shellToolName('darwin')).toBe('Bash');
    for (const s of toolSpecs('linux')) expect(s.schema).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('an unknown name is classed as a write (S11) and is not found', () => {
    expect(classOf('Patch')).toBe('write');
    expect(classOf('Read')).toBe('read');
    expect(classOf('Bash')).toBe('shell');
    expect(findTool('Patch')).toBeUndefined();
    expect(findTool('__proto__')).toBeUndefined();
    expect(findTool('constructor')).toBeUndefined();
  });
});

describe('Read', () => {
  it('numbers the lines like cat -n, and strips CRLF', async () => {
    put('a.txt', 'one\r\ntwo\nthree\n');
    expect((await run('Read', { file_path: 'a.txt' })).text).toBe('     1\tone\n     2\ttwo\n     3\tthree');
  });

  it('offset and limit', async () => {
    put('a.txt', lines(10));
    expect((await run('Read', { file_path: 'a.txt', offset: 4, limit: 2 })).text).toBe(`     4\tline 4\n     5\tline 5\n${READ_NOTE}`);
    expect((await run('Read', { file_path: 'a.txt', offset: 9 })).text).toBe('     9\tline 9\n    10\tline 10');
    const past = await run('Read', { file_path: 'a.txt', offset: 11 });
    expect(past).toMatchObject({ isError: true });
    expect(past.text).toContain('past the end');
  });

  it('2,000 lines: exactly 2000 is whole; 2001 is cut at 2000 and says how to read more', async () => {
    put('exact.txt', lines(2000));
    const whole = (await run('Read', { file_path: 'exact.txt' })).text;
    expect(whole.split('\n')).toHaveLength(2000);
    expect(whole).not.toContain(READ_NOTE);
    put('more.txt', lines(2001));
    const cut = (await run('Read', { file_path: 'more.txt' })).text.split('\n');
    expect(cut).toHaveLength(2001);
    expect(cut[1999]).toBe('  2000\tline 2000');
    expect(cut[2000]).toBe(READ_NOTE);
    // A limit above the cap is the cap.
    expect((await run('Read', { file_path: 'more.txt', limit: 5000 })).text.split('\n')).toHaveLength(2001);
  });

  it('100,000 characters: a long file is cut, the result is never longer, and it says so', async () => {
    put('wide.txt', lines(1500, 100));
    const out = (await run('Read', { file_path: 'wide.txt' })).text;
    expect(out.length).toBeLessThanOrEqual(RESULT_CAP);
    expect(out.length).toBeGreaterThan(RESULT_CAP - 400);
    expect(out.endsWith(READ_NOTE)).toBe(true);
    put('one-line.txt', 'y'.repeat(300_000));
    const one = (await run('Read', { file_path: 'one-line.txt' })).text;
    expect(one.length).toBeLessThanOrEqual(RESULT_CAP);
    expect(one.endsWith(READ_NOTE)).toBe(true);
  });

  it('a binary file, a folder and a missing file are plain error results', async () => {
    put('bin.dat', Buffer.from([1, 2, 0, 3]));
    fs.mkdirSync(path.join(cwd, 'dir'));
    expect(await run('Read', { file_path: 'bin.dat' })).toEqual({ text: 'bin.dat looks like a binary file, so Read does not open it.', isError: true });
    expect((await run('Read', { file_path: 'dir' })).text).toBe('dir is a folder, not a file. Use Glob to list what is in it.');
    expect(await run('Read', { file_path: 'nope/missing.txt' })).toEqual({ text: 'File not found: nope/missing.txt', isError: true });
    put('empty.txt', '');
    expect((await run('Read', { file_path: 'empty.txt' })).text).toBe('empty.txt is empty.');
  });
});

describe('Write', () => {
  it('creates the parent folders and says what it wrote', async () => {
    expect(await run('Write', { file_path: 'a/b/c.txt', content: 'héllo' })).toEqual({ text: 'Wrote 6 bytes to a/b/c.txt' });
    expect(fs.readFileSync(path.join(cwd, 'a', 'b', 'c.txt'), 'utf8')).toBe('héllo');
    await run('Write', { file_path: 'a/b/c.txt', content: '' });
    expect(fs.readFileSync(path.join(cwd, 'a', 'b', 'c.txt'), 'utf8')).toBe('');
  });

  it('does not replace a folder', async () => {
    fs.mkdirSync(path.join(cwd, 'dir'));
    const out = await run('Write', { file_path: 'dir', content: 'x' });
    expect(out).toMatchObject({ isError: true });
    expect(fs.statSync(path.join(cwd, 'dir')).isDirectory()).toBe(true);
  });
});

describe('Edit', () => {
  const edit = (input: Record<string, unknown>) => run('Edit', { file_path: 'f.txt', ...input });

  it('a unique match is replaced; a $ in the new text is just text', async () => {
    put('f.txt', 'alpha beta gamma');
    expect((await edit({ old_string: 'beta', new_string: '$& $1' })).text).toBe('Edited f.txt: replaced 1 occurrence.');
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf8')).toBe('alpha $& $1 gamma');
  });

  it('not found, ambiguous, identical, empty, missing file: plain errors that change nothing', async () => {
    put('f.txt', 'a b a');
    expect(await edit({ old_string: 'zzz', new_string: 'y' })).toMatchObject({ isError: true, text: expect.stringContaining('was not found in f.txt') });
    expect(await edit({ old_string: 'a', new_string: 'y' })).toEqual({ text: 'old_string was found 2 times in f.txt; add more context or set replace_all.', isError: true });
    expect(await edit({ old_string: 'a', new_string: 'a' })).toMatchObject({ isError: true, text: expect.stringContaining('the same') });
    expect(await edit({ old_string: '', new_string: 'a' })).toMatchObject({ isError: true, text: expect.stringContaining('old_string is empty') });
    expect(await run('Edit', { file_path: 'missing.txt', old_string: 'a', new_string: 'b' })).toEqual({ text: 'File not found: missing.txt', isError: true });
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf8')).toBe('a b a');
  });

  it('replace_all changes every occurrence', async () => {
    put('f.txt', 'a b a');
    expect((await edit({ old_string: 'a', new_string: 'y', replace_all: true })).text).toBe('Edited f.txt: replaced 2 occurrences.');
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf8')).toBe('y b y');
  });

  it('a CRLF file keeps its endings in the parts it did not touch, and in the part it wrote', async () => {
    put('f.txt', 'a\r\nb\r\nc\r\n');
    await edit({ old_string: 'b', new_string: 'B' });
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf8')).toBe('a\r\nB\r\nc\r\n');
    await edit({ old_string: 'a\nB', new_string: 'x\ny\nz' });
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf8')).toBe('x\r\ny\r\nz\r\nc\r\n');
  });

  it('a file that is not plain UTF-8 text is left alone', async () => {
    put('f.txt', Buffer.from([0x61, 0xff, 0x62]));
    expect(await edit({ old_string: 'a', new_string: 'b' })).toMatchObject({ isError: true });
    expect([...fs.readFileSync(path.join(cwd, 'f.txt'))]).toEqual([0x61, 0xff, 0x62]);
  });

  it('reads and writes in one synchronous step: the fs sees read then write with no async gap', () => {
    put('f.txt', 'one two');
    const order: string[] = [];
    const read = fs.readSync;
    const rename = fs.renameSync;
    vi.spyOn(fs, 'readSync').mockImplementation(((...a: Parameters<typeof read>) => (order.includes('read') || order.push('read'), read(...a))) as typeof read);
    vi.spyOn(fs, 'renameSync').mockImplementation(((...a: Parameters<typeof rename>) => (order.push('write'), rename(...a))) as typeof rename);
    const tool = findTool('Edit')!;
    const at = confine('f.txt', { cwd, home: path.join(tmp, 'home') }) as { ok: true; abs: string; root: string };
    const out = tool.run!({ file_path: 'f.txt', old_string: 'one', new_string: '1' }, ctxOf(), { abs: at.abs, root: at.root });
    // Not a promise: the whole read-modify-write was done before run() returned.
    expect(out).not.toBeInstanceOf(Promise);
    expect(order).toEqual(['read', 'write']);
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf8')).toBe('1 two');
  });

  it('two edits started together on one file both land', async () => {
    put('f.txt', 'one two');
    const tool = findTool('Edit')!;
    const at = confine('f.txt', { cwd, home: path.join(tmp, 'home') }) as { ok: true; abs: string; root: string };
    const go = (o: string, n: string) => tool.run!({ file_path: 'f.txt', old_string: o, new_string: n }, ctxOf(), { abs: at.abs, root: at.root });
    await Promise.all([go('one', '1'), go('two', '2')]);
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf8')).toBe('1 2');
  });
});

describe('Glob', () => {
  it('matches below the search folder and returns paths relative to the project, with /', async () => {
    put('src/a.ts', ''); put('src/deep/b.ts', ''); put('src/c.js', ''); put('.hidden/d.ts', '');
    expect((await run('Glob', { pattern: '**/*.ts' })).text).toBe('.hidden/d.ts\nsrc/a.ts\nsrc/deep/b.ts');
    expect((await run('Glob', { pattern: '*.ts', path: 'src' })).text).toBe('src/a.ts');
    expect((await run('Glob', { pattern: '**/*.zip' })).text).toBe('No files found.');
  });

  it('at most 500 paths, and it says so', async () => {
    for (let i = 0; i < 520; i++) put(`many/f${String(i).padStart(3, '0')}.txt`, '');
    const out = (await run('Glob', { pattern: 'many/*.txt' })).text.split('\n');
    expect(out).toHaveLength(501);
    expect(out[499]).toBe('many/f499.txt');
    expect(out[500]).toBe('[results cut at 500 paths]');
    put('few/a.txt', '');
    expect((await run('Glob', { pattern: 'few/*' })).text).toBe('few/a.txt');
  });

  it('goes 20 segments deep and no deeper', async () => {
    const dirs = (n: number) => Array.from({ length: n }, (_, i) => `d${i}`).join('/');
    put(`${dirs(19)}/leaf20.txt`, '');
    put(`${dirs(20)}/leaf21.txt`, '');
    const out = (await run('Glob', { pattern: '**/leaf*.txt' })).text;
    expect(out).toContain('leaf20.txt');
    expect(out).not.toContain('leaf21.txt');
  });

  it('skips node_modules and .git', async () => {
    put('node_modules/pkg/i.js', ''); put('.git/config', ''); put('sub/node_modules/x.js', ''); put('keep.js', '');
    expect((await run('Glob', { pattern: '**/*' })).text).toBe('keep.js');
  });

  it('a link inside the folder to outside is not followed (no folder behind it is even listed)', async (t) => {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    const why = link(outside, path.join(cwd, 'out'));
    if (why) return t.skip(`SKIPPED: ${why}`);
    put('ok.txt', '');
    const listed: string[] = [];
    const real = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: string, ...rest: unknown[]) => (listed.push(String(p)), (real as (...a: unknown[]) => unknown)(p, ...rest))) as typeof real);
    expect((await run('Glob', { pattern: '**/*' })).text).toBe('ok.txt');
    expect(listed.filter((p) => path.resolve(p).startsWith(path.join(cwd, 'out')))).toEqual([]);
    expect((await run('Grep', { pattern: 'x' })).text).toBe('No matches found.');
  });

  it('a result whose real path is outside the project, or in the Reins home, is dropped', async () => {
    put('ok.txt', ''); put('evil.txt', ''); put('home/x.txt', '');
    const real = fs.realpathSync.native;
    const lying: FsLike = {
      lstatSync: fs.lstatSync,
      realpathSync: { native: (p: string) => (p.endsWith('evil.txt') ? path.join(outside, 'x') : real(p)) },
    };
    const out = (await run('Glob', { pattern: '**/*.txt' }, ctxOf({ fs: lying, home: path.join(cwd, 'home') }))).text;
    expect(out).toBe('ok.txt');
  });

  it('a pattern with .. segments is refused before anything is walked', () => {
    const rc = { home: path.join(tmp, 'home'), cwd, platform: process.platform };
    for (const pattern of ['../../**', '../*', 'a/../b', 'a\\..\\b', '..']) expect(findTool('Glob')!.refuse!({ pattern }, rc)).toContain('may not have .. segments');
    expect(findTool('Glob')!.refuse!({ pattern: 'a/..b/*' }, rc)).toBeUndefined();
    expect(findTool('Grep')!.refuse!({ pattern: 'x', glob: '../*.ts' }, rc)).toContain('may not have .. segments');
    expect(findTool('Grep')!.refuse!({ pattern: '..' }, rc)).toBeUndefined();
  });
});

describe('Grep', () => {
  beforeEach(() => {
    put('a.ts', 'const Foo = 1;\nconst bar = 2;\nfoo again\n');
    put('b.js', 'nothing here\nfoo\n');
    put('sub/c.ts', 'FOO FOO\n');
  });

  it('content mode (default): file:line:text, with the project-relative path', async () => {
    expect((await run('Grep', { pattern: 'foo' })).text).toBe('a.ts:3:foo again\nb.js:2:foo');
  });

  it('-i ignores case', async () => {
    expect((await run('Grep', { pattern: 'foo', '-i': true })).text).toBe('a.ts:1:const Foo = 1;\na.ts:3:foo again\nb.js:2:foo\nsub/c.ts:1:FOO FOO');
  });

  it('files_with_matches and count', async () => {
    expect((await run('Grep', { pattern: 'foo', '-i': true, output_mode: 'files_with_matches' })).text).toBe('a.ts\nb.js\nsub/c.ts');
    expect((await run('Grep', { pattern: 'foo', '-i': true, output_mode: 'count' })).text).toBe('a.ts:2\nb.js:1\nsub/c.ts:1');
  });

  it('glob filters the files (a bare *.ts matches in any folder); path can be one file', async () => {
    expect((await run('Grep', { pattern: 'foo', '-i': true, glob: '*.ts', output_mode: 'files_with_matches' })).text).toBe('a.ts\nsub/c.ts');
    expect((await run('Grep', { pattern: 'foo', path: 'sub' })).text).toBe('No matches found.');
    expect((await run('Grep', { pattern: 'FOO', path: 'sub' })).text).toBe('sub/c.ts:1:FOO FOO');
    expect((await run('Grep', { pattern: 'bar', path: 'a.ts' })).text).toBe('a.ts:2:const bar = 2;');
  });

  it('at most 500 matches, and it says so', async () => {
    put('big.txt', 'hit\n'.repeat(700));
    const out = (await run('Grep', { pattern: 'hit' })).text.split('\n');
    expect(out).toHaveLength(501);
    expect(out[500]).toBe('[results cut at 500]');
  });

  it('skips binary files and files over 2 MB', async () => {
    put('bin.dat', Buffer.concat([Buffer.from([0]), Buffer.from('needle')]));
    put('huge.txt', 'needle\n' + 'x'.repeat(2 * 1024 * 1024));
    put('small.txt', 'needle\n');
    expect((await run('Grep', { pattern: 'needle' })).text).toBe('small.txt:1:needle\n[skipped 1 file over 2 MB]');
  });

  it('a pattern that does not compile is a plain error result', async () => {
    const out = await run('Grep', { pattern: '(' });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('not a valid regular expression');
  });

  it('stops scanning at 50 MB and says so', async () => {
    put('a-first.txt', 'needle\n');
    const filler = Buffer.from('filler line\n'.repeat(160_000)); // about 1.9 MB
    for (let i = 0; i < 30; i++) put(`f${String(i).padStart(2, '0')}.txt`, filler);
    put('zz-last.txt', 'needle\n');
    const out = (await run('Grep', { pattern: 'needle' })).text;
    expect(out).toContain('a-first.txt:1:needle');
    expect(out).toContain('search stopped: scanned 50 MB');
    expect(out).not.toContain('zz-last.txt');
  }, 60_000);

  it('an aborted search returns at once', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await run('Grep', { pattern: 'foo' }, ctxOf({ signal: ac.signal }))).toMatchObject({ isError: true });
  });
});

describe('results are redacted and capped (8.3 choke point 3)', () => {
  const redact = (t: string, max?: number) => {
    const red = t.split(KEY).join('[key Reins]');
    return max === undefined ? red : red.slice(0, max);
  };

  it('cutText: a text over the cap is cut after redacting, in the cap, with a note', () => {
    const all = (t: string) => redact(t);
    const out = cutText(redact, all, 'a'.repeat(RESULT_CAP + 50));
    expect(out.length).toBe(RESULT_CAP);
    expect(out.endsWith(CUT_NOTE)).toBe(true);
    expect(cutText(redact, all, `k ${KEY} k`)).toBe('k [key Reins] k');
    expect(cutText(redact, all, 'a'.repeat(RESULT_CAP))).toBe('a'.repeat(RESULT_CAP));
  });
});

// ---- the engine --------------------------------------------------------------------------------------------------------------------

const rigs: Rig[] = [];
// The tools see the host's platform (real paths). A test that sets `deps.platform` must not touch the file system.
const make = async (wire: WireId, o: Parameters<typeof rig>[1] = {}) => {
  const r = await rig(wire, o);
  rigs.push(r);
  return r;
};
const SHELL = shellToolName(process.platform);
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});
const call = (id: string, name: string, args: unknown) => ({ id, name, args: typeof args === 'string' ? args : JSON.stringify(args) });
const calls = (...c: ReturnType<typeof call>[]) => ({ toolCalls: c });
const open = (r: Rig, policy: Policy = WRITE_MODE, o: { cwd?: string } = {}) => r.open({ cwd: o.cwd ?? cwd, policy: () => policy });
const asked = (r: Rig, at = 1) => toolResults(r.fake.requests[at]!.body);
const ofType = <T extends EngineEvent['type']>(ev: EngineEvent[], type: T) => ev.filter((e): e is Extract<EngineEvent, { type: T }> => e.type === type);
const records = (ev: EngineEvent[]): RunEventRecord[] =>
  ev.filter((e) => e.type === 'refusal').map((e, i) => ({ id: String(i), timestamp: i, type: 'refusal', data: { reason: (e as { reason: string }).reason } }) as RunEventRecord);

describe.each(WIRES)('the loop runs the tools, on %s', (wireId) => {
  it('Read, Write, Edit, Glob, Grep: events in order, results in the next request, one usage last', async () => {
    const r = await make(wireId, { strictPairs: true });
    put('a.txt', 'hello\n');
    r.push(
      calls(call('c1', 'Read', { file_path: 'a.txt' }), call('c2', 'Write', { file_path: 'sub/w.txt', content: 'abc' }), call('c3', 'Edit', { file_path: 'a.txt', old_string: 'hello', new_string: 'bye' })),
      calls(call('c4', 'Glob', { pattern: '**/*.txt' }), call('c5', 'Grep', { pattern: 'bye', output_mode: 'files_with_matches' })),
      { text: 'all done' },
    );
    const res = await (await open(r)).turn('go');
    expect(res.text).toBe('all done');
    expect(res.isError).toBeUndefined();
    expect(types(res.events).filter((t) => t === 'usage')).toHaveLength(1);
    expect(res.events!.at(-1)!.type).toBe('usage');
    expect(asked(r).map((x) => x.id)).toEqual(['c1', 'c2', 'c3']);
    expect(asked(r)[0]!.content).toBe('     1\thello');
    expect(asked(r)[1]!.content).toBe('Wrote 3 bytes to sub/w.txt');
    expect(asked(r)[2]!.content).toBe('Edited a.txt: replaced 1 occurrence.');
    expect(asked(r, 2).slice(-2).map((x) => x.content)).toEqual(['a.txt\nsub/w.txt', 'a.txt']);
    expect(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('bye\n');
    // tool_call events come before the results of the same batch
    const seq = res.events!.filter((e) => e.type === 'tool_call' || e.type === 'tool_result').map((e) => `${e.type}:${(e as { tool: string }).tool}`);
    expect(seq.slice(0, 6)).toEqual(['tool_call:Read', 'tool_call:Write', 'tool_call:Edit', 'tool_result:Read', 'tool_result:Write', 'tool_result:Edit']);
    expect(r.live).toEqual(res.events);
  });

  it('the request carries the tool specs; a model with tools: false gets none and its stray call is refused', async () => {
    const r = await make(wireId, { manifest: { models: [{ id: 'm', context: 1000, tools: false }] }, strictPairs: true });
    r.push(calls(call('c1', 'Read', { file_path: 'a.txt' })), { text: 'ok' });
    put('a.txt', 'secret contents');
    const res = await (await open(r)).turn('go');
    expect(r.fake.requests[0]!.body.tools).toBeUndefined();
    expect(asked(r)[0]!.content).toBe('Reins has no tool Read; this model works without tools.');
    expect(JSON.stringify(res.events)).not.toContain('secret contents');
    expect(ofType(res.events!, 'refusal')).toHaveLength(1);

    const on = await make(wireId);
    on.push({ text: 'ok' });
    await (await open(on)).turn('hi');
    const names = on.fake.requests[0]!.body.tools.map((t: any) => t.name ?? t.function?.name);
    expect(names).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', SHELL]);
  });

  it('an unknown tool is refused with the 4.2 words, with refusal and hook events, and nothing runs', async () => {
    // Platform 'linux' for the literal words of the spec; no file is touched by this test.
    const r = await make(wireId, { strictPairs: true, deps: { platform: 'linux' } });
    r.push(calls(call('c1', 'Patch', { file_path: 'a.txt', diff: 'x' })), { text: 'ok' });
    const res = await (await open(r)).turn('go');
    const words = 'Reins has no tool Patch; use one of: Read, Write, Edit, Glob, Grep, Bash.';
    expect(asked(r)).toEqual([{ id: 'c1', content: words }]);
    expect(res.events).toContainEqual({ type: 'refusal', reason: words });
    expect(res.events).toContainEqual({ type: 'hook', event: 'pre-tool', tool: 'Patch', decision: 'deny', reason: words });
    expect(res.events).toContainEqual({ type: 'tool_result', tool: 'Patch', output: words });
    expect(fs.existsSync(path.join(cwd, 'a.txt'))).toBe(false);
  });

  it('Windows names its shell PowerShell in the same sentence', async () => {
    const r = await make(wireId, { deps: { platform: 'win32' }, strictPairs: true });
    r.push(calls(call('c1', 'Patch', {})), { text: 'ok' });
    await (await open(r)).turn('go');
    expect(asked(r)[0]!.content).toBe('Reins has no tool Patch; use one of: Read, Write, Edit, Glob, Grep, PowerShell.');
  });
});

describe('bad arguments are plain results, never a crash', () => {
  it.each([
    ['not JSON', '{"file_path":', /^Your arguments were not valid JSON: .+\. Call the tool again\.$/],
    ['an array', '["a.txt"]', 'The input of Read must be a JSON object with "file_path".'],
    ['a string', '"a.txt"', 'The input of Read must be a JSON object with "file_path".'],
    ['null', 'null', 'The input of Read must be a JSON object with "file_path".'],
    ['a missing field', '{}', 'Read: "file_path" is required.'],
    ['a number for a string', '{"file_path":5}', 'Read: "file_path" must be a string.'],
    ['a string for a number', '{"file_path":"a.txt","offset":"2"}', 'Read: "offset" must be a whole number.'],
    ['a fraction', '{"file_path":"a.txt","limit":1.5}', 'Read: "limit" must be a whole number.'],
    ['a number under the minimum', '{"file_path":"a.txt","offset":0}', 'Read: "offset" must be at least 1.'],
  ])('%s', async (_name, args, expected) => {
    const r = await make('openai-chat', { strictPairs: true });
    put('a.txt', 'x');
    r.push(calls(call('c1', 'Read', args)), { text: 'still here' });
    const res = await (await open(r)).turn('go');
    expect(res.text).toBe('still here');
    const got = asked(r)[0]!.content;
    if (typeof expected === 'string') expect(got).toBe(expected);
    else expect(got).toMatch(expected);
    expect(ofType(res.events!, 'refusal')).toHaveLength(0);
  });

  it('other tools name their field too', async () => {
    const r = await make('openai-chat', { strictPairs: true });
    r.push(calls(call('a', 'Write', { file_path: 'x.txt' }), call('b', 'Edit', { file_path: 'x.txt', old_string: 'a', new_string: 'b', replace_all: 'yes' }), call('c', 'Grep', { pattern: 'a', output_mode: 'tree' }), call('d', SHELL, {})), { text: 'ok' });
    await (await open(r)).turn('go');
    expect(asked(r).map((x) => x.content)).toEqual([
      'Write: "content" is required.', 'Edit: "replace_all" must be true or false.', 'Grep: "output_mode" must be one of: content, files_with_matches, count.', `${SHELL}: "command" is required.`,
    ]);
    expect(fs.existsSync(path.join(cwd, 'x.txt'))).toBe(false);
  });
});

describe('outside the folder, the shell: asked, and a no stops them', () => {
  it('a read outside the project, a write outside the project and a shell call', async () => {
    const r = await make('openai-chat', { strictPairs: true, ...SAYS_NO });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET');
    r.push(
      calls(
        call('a', 'Read', { file_path: '../outside/secret.txt' }), call('b', 'Write', { file_path: path.join(outside, 'new.txt'), content: 'x' }),
        call('c', SHELL, { command: 'echo hi' }), call('d', 'Grep', { pattern: 'SECRET', path: '../outside' }), call('e', 'Glob', { pattern: '*', path: outside }),
      ),
      { text: 'ok' },
    );
    const res = await (await open(r)).turn('go');
    expect(asked(r).map((x) => x.content)).toEqual([NO, NO, NO, NO, NO]);
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
    expect(JSON.stringify(res.events)).not.toContain('TOP SECRET');
    // A user's no is not a guard refusal.
    expect(ofType(res.events!, 'refusal')).toHaveLength(0);
    for (const tool of ['Read', 'Write', SHELL, 'Grep', 'Glob']) expect(res.events).toContainEqual({ type: 'hook', event: 'approve', tool, decision: 'deny', reason: NO });
  });

  it('a read inside the project next to one outside is not run in a batch with it (the batch goes call by call)', async () => {
    const r = await make('openai-chat', { strictPairs: true, ...SAYS_NO });
    put('in.txt', 'inside');
    r.push(calls(call('a', 'Read', { file_path: 'in.txt' }), call('b', 'Read', { file_path: '../outside/x' })), { text: 'ok' });
    await (await open(r)).turn('go');
    expect(asked(r).map((x) => x.content)).toEqual(['     1\tinside', NO]);
  });

  it('the policy answers first: a shell call in a read-only step says read-only and is never asked', async () => {
    const r = await make('openai-chat', { strictPairs: true });
    r.push(calls(call('a', SHELL, { command: 'ls' })), { text: 'ok' });
    await (await open(r, { mode: 'read-only', guards: [], allowShell: false })).turn('go');
    expect(asked(r)[0]!.content).toContain('this step is read-only, so shell commands are blocked');
  });
});

describe('confinement through the engine', () => {
  it('a symlink or junction to outside: a read through it is outside, so it is asked (and a no stops it)', async (t) => {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET');
    const why = link(outside, path.join(cwd, 'out'));
    if (why) return t.skip(`SKIPPED: ${why}`);
    const r = await make('openai-chat', { strictPairs: true, ...SAYS_NO });
    r.push(calls(call('a', 'Read', { file_path: 'out/secret.txt' }), call('b', 'Write', { file_path: 'out/new.txt', content: 'x' })), { text: 'ok' });
    await (await open(r)).turn('go');
    expect(asked(r).map((x) => x.content)).toEqual([NO, NO]);
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
  });

  it('device, network and short-name paths are refused with the lexical words', async () => {
    const r = await make('openai-chat', { strictPairs: true });
    r.push(calls(call('a', 'Read', { file_path: '\\\\host\\share\\x' }), call('b', 'Write', { file_path: 'nul.txt', content: 'x' }), call('c', 'Read', { file_path: 'a\\ADMIN~1\\b' })), { text: 'ok' });
    await (await open(r)).turn('go');
    expect(asked(r).map((x) => x.content)).toEqual([
      'Blocked by Reins: Reins does not open network, device or short-name paths (\\\\host\\share\\x).',
      'Blocked by Reins: Reins does not open network, device or short-name paths (nul.txt).',
      'Blocked by Reins: Reins does not open network, device or short-name paths (a\\ADMIN~1\\b).',
    ]);
  });

  it('a path under the Reins home is refused even inside the project and even when everything would be allowed', async () => {
    const inner = path.join(cwd, '.reins');
    fs.mkdirSync(inner);
    fs.writeFileSync(path.join(inner, 'secrets.json'), '{"providers":{}}');
    const r = await make('openai-chat', { strictPairs: true, host: { home: inner, onApprove: async () => ({ behavior: 'allow' }) } });
    r.push(
      calls(call('a', 'Read', { file_path: '.reins/secrets.json' }), call('b', 'Write', { file_path: '.reins/conversations/x.jsonl', content: 'x' }), call('c', 'Grep', { pattern: 'providers', path: '.reins' })),
      { text: 'ok' },
    );
    const res = await (await open(r)).turn('go');
    expect(asked(r).map((x) => x.content)).toEqual([HOME_WORDS, HOME_WORDS, HOME_WORDS]);
    expect(fs.existsSync(path.join(inner, 'conversations'))).toBe(false);
    expect(JSON.stringify(res.events)).not.toContain('"providers":{}');
  });

  it('a Grep over the project never shows a file inside the Reins home', async () => {
    const inner = path.join(cwd, '.reins');
    put('.reins/secrets.json', 'needle');
    put('visible.txt', 'needle');
    const r = await make('openai-chat', { host: { home: inner } });
    r.push(calls(call('a', 'Grep', { pattern: 'needle' }), call('b', 'Glob', { pattern: '**/*' })), { text: 'ok' });
    await (await open(r)).turn('go');
    expect(asked(r).map((x) => x.content)).toEqual(['visible.txt:1:needle', 'visible.txt']);
  });
});

describe('checkTool and the receipt (6)', () => {
  it('a guarded path, read-only mode and a pending gate refuse a write, in the policy\'s words', async () => {
    const r = await make('openai-chat', { strictPairs: true });
    put('migrations/1.sql', 'old');
    const write = (id: string) => call(id, 'Write', { file_path: 'migrations/1.sql', content: 'new' });
    r.push(calls(write('a'), call('b', 'Edit', { file_path: './migrations/../migrations/1.sql', old_string: 'old', new_string: 'new' })), { text: 'ok' });
    const res = await (await open(r, { mode: 'write', guards: ['migrations/**'], allowShell: true })).turn('go');
    expect(asked(r).map((x) => x.content)).toEqual([
      'Blocked by Reins: migrations/1.sql is guarded (migrations/**). Do not touch it.',
      'Blocked by Reins: migrations/1.sql is guarded (migrations/**). Do not touch it.',
    ]);
    expect(fs.readFileSync(path.join(cwd, 'migrations', '1.sql'), 'utf8')).toBe('old');
    expect(receipt(records(res.events!))).toMatchObject({ guardRefusals: 2, readOnlyRefusals: 0, totalRefusals: 2 });

    const ro = await make('openai-chat', { strictPairs: true });
    ro.push(calls(write('a')), { text: 'ok' });
    const roRes = await (await open(ro, { mode: 'read-only', guards: [], allowShell: true })).turn('go');
    expect(asked(ro)[0]!.content).toBe('Blocked by Reins: this step is read-only. Finish the step; edits unlock after the gate.');
    expect(receipt(records(roRes.events!))).toMatchObject({ readOnlyRefusals: 1, guardRefusals: 0, totalRefusals: 1 });

    const gate = await make('openai-chat', { strictPairs: true });
    gate.push(calls(write('a')), { text: 'ok' });
    await (await open(gate, { mode: 'write', guards: [], allowShell: true, pendingGate: 'tests' })).turn('go');
    expect(asked(gate)[0]!.content).toBe('Blocked by Reins: waiting for gate "tests". Edits unlock after it passes.');
    expect(fs.readFileSync(path.join(cwd, 'migrations', '1.sql'), 'utf8')).toBe('old');
  });

  it('a guard also holds for the real path: a link to a guarded file inside the project', async (t) => {
    fs.mkdirSync(path.join(cwd, 'migrations'));
    const why = link(path.join(cwd, 'migrations'), path.join(cwd, 'alias'));
    if (why) return t.skip(`SKIPPED: ${why}`);
    put('migrations/1.sql', 'old');
    const r = await make('openai-chat', { strictPairs: true });
    r.push(calls(call('a', 'Write', { file_path: 'alias/1.sql', content: 'new' })), { text: 'ok' });
    await (await open(r, { mode: 'write', guards: ['migrations/**'], allowShell: true })).turn('go');
    expect(asked(r)[0]!.content).toContain('is guarded (migrations/**)');
    expect(fs.readFileSync(path.join(cwd, 'migrations', '1.sql'), 'utf8')).toBe('old');
  });

  it('the receipt counts a guard refusal as one and every confinement refusal as none', async () => {
    // The outside read and the shell call are asked (a no is not a refusal), so five of the seven calls are refusals.
    const r = await make('openai-chat', { strictPairs: true, ...SAYS_NO });
    r.push(
      calls(
        call('a', 'Read', { file_path: '../outside/x' }), call('b', 'Read', { file_path: 'con' }), call('c', 'Patch', {}), call('d', 'Glob', { pattern: '../../**' }),
        call('e', SHELL, { command: 'ls' }), call('f', 'Read', { file_path: '' }), call('g', 'Read', { file_path: path.join(r.host.home, 'secrets.json') }),
      ),
      { text: 'ok' },
    );
    const res = await (await open(r)).turn('go');
    const refusals = ofType(res.events!, 'refusal').map((e) => e.reason);
    expect(refusals).toHaveLength(5);
    expect(refusals).toContain(HOME_WORDS);
    for (const reason of refusals) expect(reason).not.toMatch(/guard|read-only/i);
    expect(receipt(records(res.events!))).toMatchObject({ guardRefusals: 0, readOnlyRefusals: 0, totalRefusals: 5 });
  });
});

describe('batches (4.4)', () => {
  /** Makes each Read take `ms[name]` and records when each finished. */
  function slowReads(ms: Record<string, number>) {
    const done: string[] = [];
    const real = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: string, ...rest: unknown[]) => {
      const name = path.basename(String(p));
      await new Promise((ok) => setTimeout(ok, ms[name] ?? 0));
      done.push(name);
      return (real as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.promises.open);
    return done;
  }

  it('reads inside the project run at once: two 400 ms reads take about one', async () => {
    put('a.txt', 'A'); put('b.txt', 'B');
    const done = slowReads({ 'a.txt': 400, 'b.txt': 400 });
    const r = await make('openai-chat', { strictPairs: true });
    r.push(calls(call('1', 'Read', { file_path: 'a.txt' }), call('2', 'Read', { file_path: 'b.txt' }), call('3', 'Glob', { pattern: '*.txt' })), { text: 'ok' });
    const s = await open(r);
    const started = Date.now();
    await s.turn('go');
    const took = Date.now() - started;
    expect(done).toHaveLength(2);
    expect(took).toBeGreaterThanOrEqual(380);
    expect(took).toBeLessThan(700);
    expect(asked(r).map((x) => x.content)).toEqual(['     1\tA', '     1\tB', 'a.txt\nb.txt']);
  });

  it('the results keep the model\'s order, not the order the reads finished in', async () => {
    put('slow.txt', 'S'); put('fast.txt', 'F');
    const done = slowReads({ 'slow.txt': 300, 'fast.txt': 10 });
    const r = await make('openai-chat', { strictPairs: true });
    r.push(calls(call('1', 'Read', { file_path: 'slow.txt' }), call('2', 'Read', { file_path: 'fast.txt' })), { text: 'ok' });
    const res = await (await open(r)).turn('go');
    expect(done).toEqual(['fast.txt', 'slow.txt']);
    expect(asked(r)).toEqual([{ id: '1', content: '     1\tS' }, { id: '2', content: '     1\tF' }]);
    expect(ofType(res.events!, 'tool_result').map((e) => e.output)).toEqual(['     1\tS', '     1\tF']);
  });

  it('a batch with a write runs one by one in the model\'s order', async () => {
    put('slow.txt', 'S');
    const done = slowReads({ 'slow.txt': 300 });
    const log: string[] = [];
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((...a: Parameters<typeof rename>) => {
      if (String(a[1]).endsWith('w.txt')) log.push(`write after ${done.length} reads`);
      return rename(...a);
    }) as typeof rename);
    const r = await make('openai-chat', { strictPairs: true });
    r.push(calls(call('1', 'Read', { file_path: 'slow.txt' }), call('2', 'Write', { file_path: 'w.txt', content: 'W' }), call('3', 'Read', { file_path: 'w.txt' })), { text: 'ok' });
    await (await open(r)).turn('go');
    expect(log).toEqual(['write after 1 reads']);
    expect(asked(r).map((x) => x.content)).toEqual(['     1\tS', 'Wrote 1 bytes to w.txt', '     1\tW']);
  });
});

describe('fail closed (4.5)', () => {
  it('a policy that throws is a deny with the internal-error words, and the write does not happen', async () => {
    const r = await make('openai-chat', { strictPairs: true });
    r.push(calls(call('a', 'Write', { file_path: 'w.txt', content: 'x' })), { text: 'ok' });
    const s = await r.open({ cwd, policy: () => { throw new Error('policy broke'); } });
    const res = await s.turn('go');
    expect(res.text).toBe('ok');
    const words = 'Blocked by Reins: internal error (policy broke).';
    expect(asked(r)[0]!.content).toBe(words);
    expect(res.events).toContainEqual({ type: 'hook', event: 'pre-tool', tool: 'Write', decision: 'deny', reason: words });
    expect(fs.existsSync(path.join(cwd, 'w.txt'))).toBe(false);
  });

  it('a confinement that throws is a deny too, for a read as well', async () => {
    const boom: FsLike = { realpathSync: { native: () => { throw new Error('disk exploded'); } }, lstatSync: fs.lstatSync };
    const r = await make('openai-chat', { strictPairs: true, deps: { fs: boom } });
    put('a.txt', 'x');
    r.push(calls(call('a', 'Read', { file_path: 'a.txt' }), call('b', 'Write', { file_path: 'w.txt', content: 'x' })), { text: 'ok' });
    const res = await (await open(r)).turn('go');
    expect(asked(r).map((x) => x.content)).toEqual(['Blocked by Reins: internal error (disk exploded).', 'Blocked by Reins: internal error (disk exploded).']);
    expect(res.text).toBe('ok');
    expect(fs.existsSync(path.join(cwd, 'w.txt'))).toBe(false);
  });

  it('the internal-error message is redacted', async () => {
    const r = await make('openai-chat', { strictPairs: true });
    r.push(calls(call('a', 'Write', { file_path: 'w.txt', content: 'x' })), { text: 'ok' });
    await (await r.open({ cwd, policy: () => { throw new Error(`bad ${KEY}`); } })).turn('go');
    expect(asked(r)[0]!.content).toBe('Blocked by Reins: internal error (bad [key Reins]).');
  });
});

describe('redaction (8.3)', () => {
  it.each(WIRES)('a file that holds the key: the events and the turn result show [key Reins]; the result is redacted in the next request too, on %s', async (wireId) => {
    // The provider-bound history is intentionally NOT the thing under test for assistant text (it stays raw); a tool result enters the conversation redacted.
    const r = await make(wireId, { strictPairs: true });
    put('env.txt', `API=${KEY}\n`);
    r.push(calls(call('a', 'Read', { file_path: 'env.txt' }), call('b', 'Grep', { pattern: 'API' })), { text: 'done' });
    const res = await (await open(r)).turn('go');
    expect(JSON.stringify(res.events)).not.toContain(KEY);
    expect(JSON.stringify(res)).not.toContain(KEY);
    expect(JSON.stringify(r.live)).not.toContain(KEY);
    expect(ofType(res.events!, 'tool_result').map((e) => e.output)).toEqual(['     1\tAPI=[key Reins]', 'env.txt:1:API=[key Reins]']);
    expect(JSON.stringify(r.fake.requests[1]!.body)).not.toContain(KEY);
  });

  it.each(WIRES)('a key split across two text deltas is redacted in the text event and in TurnResult.text, on %s', async (wireId) => {
    const r = await make(wireId);
    const half = Math.floor(KEY.length / 2);
    const a = `use ${KEY.slice(0, half)}`;
    const b = `${KEY.slice(half)} now`;
    const sse = (type: string, o: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
    const chunk = (d: object) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: d, finish_reason: null }] })}\n\n`;
    const body = wireId === 'openai-chat'
      ? chunk({ role: 'assistant', content: a }) + chunk({ content: b }) + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` + 'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n'
      : sse('message_start', { message: { usage: { input_tokens: 1, output_tokens: 1 } } }) + sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        + sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: a } }) + sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: b } })
        + sse('content_block_stop', { index: 0 }) + sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) + sse('message_stop', {});
    r.push({ status: 200, headers: { 'content-type': 'text/event-stream' }, body });
    const res = await (await open(r)).turn('go');
    expect(res.text).toBe('use [key Reins] now');
    expect(ofType(res.events!, 'text')).toEqual([{ type: 'text', text: 'use [key Reins] now' }]);
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it('a text that ends in the first letter of the key keeps it (whole-message redaction does not trim an ordinary end)', async () => {
    const r = await make('openai-chat');
    r.push({ text: 'the tests' });
    expect((await (await open(r)).turn('go')).text).toBe('the tests');
  });

  it('a result over 100,000 characters is cut after redaction, in the cap, and never ends on the start of a key', async () => {
    const note = `\n${READ_NOTE}`;
    const partial = KEY.slice(0, 10);
    // The Read body is "     1\t" + the line; the cut is at RESULT_CAP minus the note, so the partial key sits right before it.
    put('wide.txt', `${KEY} ${'a'.repeat(RESULT_CAP - note.length - 7 - 12 - partial.length)}${partial}${'z'.repeat(2000)}\n`);
    const r = await make('openai-chat', { strictPairs: true });
    r.push(calls(call('a', 'Read', { file_path: 'wide.txt' })), { text: 'ok' });
    const res = await (await open(r)).turn('go');
    const out = ofType(res.events!, 'tool_result')[0]!.output as string;
    expect(out.length).toBeLessThanOrEqual(RESULT_CAP);
    expect(out).not.toContain(KEY);
    expect(out).toContain('[key Reins]');
    expect(out.endsWith(READ_NOTE)).toBe(true);
    // the partial key right before the cut was held back, not shown
    expect(out).not.toContain('sk-');
    expect(asked(r)[0]!.content).toBe(out);
  });

  it('a Grep result over 100,000 characters is cut with the generic note', async () => {
    put('wide.txt', `${'m'.repeat(450)}\n`.repeat(400));
    const r = await make('openai-chat', { strictPairs: true });
    r.push(calls(call('a', 'Grep', { pattern: 'm' })), { text: 'ok' });
    const res = await (await open(r)).turn('go');
    const out = ofType(res.events!, 'tool_result')[0]!.output as string;
    expect(out.length).toBeLessThanOrEqual(RESULT_CAP);
    expect(out.endsWith(CUT_NOTE)).toBe(true);
  });
});

describe('interrupt (4.10)', () => {
  it('an interrupt during a long Grep ends the turn within 1 s; the call that did not finish is stubbed', async () => {
    for (let d = 0; d < 60; d++) for (let f = 0; f < 150; f++) put(`d${d}/f${f}.txt`, 'nothing to see here\n'.repeat(5));
    const r = await make('openai-chat', { strictPairs: true });
    r.push(calls(call('a', 'Grep', { pattern: 'zzz-never' })));
    const s = await open(r);
    let at = 0;
    r.host.onLive = (e) => {
      r.live.push(e);
      if (e.type === 'tool_call') setTimeout(() => { at = Date.now(); void s.interrupt(); }, 30);
    };
    const res = await s.turn('go');
    const took = Date.now() - at;
    expect(at).toBeGreaterThan(0);
    expect(took).toBeLessThan(1000);
    expect(res.text).toBe('');
    expect(res.isError).toBeUndefined();
    expect(res.events).toContainEqual({ type: 'tool_result', tool: 'Grep', output: INTERRUPTED });
    expect(r.fake.requests).toHaveLength(1);
    // the history is whole: the next turn is accepted by a strict API
    r.host.onLive = (e) => void r.live.push(e);
    r.push({ text: 'again' });
    expect((await s.turn('hi')).text).toBe('again');
    expect(asked(r, 1)).toEqual([{ id: 'a', content: INTERRUPTED }]);
  }, 60_000);

  it('finished calls of an interrupted batch are kept, the rest are stubbed', async () => {
    put('a.txt', 'A');
    const r = await make('openai-chat', { strictPairs: true });
    r.push(calls(call('1', 'Write', { file_path: 'w1.txt', content: '1' }), call('2', 'Write', { file_path: 'w2.txt', content: '2' })), { text: 'ok' });
    const s = await open(r);
    r.host.onLive = (e) => {
      r.live.push(e);
      if (e.type === 'tool_result' && e.tool === 'Write') void s.interrupt();
    };
    const res = await s.turn('go');
    expect(res.text).toBe('');
    expect(fs.existsSync(path.join(cwd, 'w1.txt'))).toBe(true);
    expect(fs.existsSync(path.join(cwd, 'w2.txt'))).toBe(false);
    r.host.onLive = (e) => void r.live.push(e);
    await s.turn('again');
    expect(asked(r).sort((a, b) => a.id.localeCompare(b.id))).toEqual([{ id: '1', content: 'Wrote 1 bytes to w1.txt' }, { id: '2', content: INTERRUPTED }]);
  });
});
