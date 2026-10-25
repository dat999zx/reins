// Approvals, cards in the middle of a turn, and the system prompt of the API agent loop (Task 13; spec 4.5, 4.11). Real temp folders, the fake provider,
// a fake key only. Shell commands are chosen by platform. A test that cannot run here says SKIPPED and why.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Decision, EngineEvent, OpenOptions, Policy, ToolRequest } from '@reins/core';
import { wrapCard } from '../src/cards.js';
import { setKey } from '../src/secrets.js';
import { AGENTS_CUT, AGENTS_MAX, readAgents, systemPrompt } from '../src/loop/system.js';
import { HOME_WORDS, type FsLike } from '../src/loop/paths.js';
import { HOME_NAMED_WORDS } from '../src/loop/shell.js';
import { shellToolName } from '../src/loop/tools.js';
import { PRICE, KEY, WIRES, rig, toolResults, type Rig, type WireId } from './loop-harness.js';

const win = process.platform === 'win32';
const SHELL = shellToolName(process.platform);
const WRITE_MODE: Policy = { mode: 'write', guards: [], allowShell: true };
const INTERRUPTED = 'Interrupted; the tool did not finish.';
const DEFAULT_DENY = 'Denied by the user in Reins.';
const NO = 'The user said no.';
/** The reason of a question about a path outside the project: it names the real destination. */
const outsideOf = (abs: string) => `outside the project (${abs})`;
const ALLOW = async (_q?: ToolRequest): Promise<Decision> => ({ behavior: 'allow' });
const DENY = async (_q?: ToolRequest): Promise<Decision> => ({ behavior: 'deny', message: NO });
const ENV: NodeJS.ProcessEnv = { ...process.env, NODE: process.execPath };

let tmp = '';
let cwd = '';
let outside = '';
let scripts = '';
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-approve-')));
  cwd = path.join(tmp, 'proj');
  outside = path.join(tmp, 'outside');
  scripts = path.join(tmp, 'scripts');
  for (const d of [cwd, outside, scripts]) fs.mkdirSync(d);
  // tree.js FILE -> starts a child that sleeps, writes "<own pid> <child pid>" to FILE, then sleeps itself.
  fs.writeFileSync(
    path.join(scripts, 'tree.js'),
    `const cp = require('node:child_process');\nconst c = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });\nrequire('node:fs').writeFileSync(process.argv[2], process.pid + ' ' + c.pid);\nsetTimeout(() => {}, 60000);`,
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  // A process that was just killed may hold its folder for a moment on Windows.
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i >= 40) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});
const make = async (wire: WireId = 'openai-chat', o: Parameters<typeof rig>[1] = {}) => {
  const r = await rig(wire, { strictPairs: true, ...o, host: { shellEnv: () => ENV, ...o.host } });
  rigs.push(r);
  return r;
};
const call = (id: string, name: string, args: unknown) => ({ id, name, args: JSON.stringify(args) });
const calls = (...c: Array<ReturnType<typeof call>>) => ({ toolCalls: c });
const start = (r: Rig, o: Partial<OpenOptions> = {}, policy: Policy = WRITE_MODE) => r.open({ cwd, policy: () => policy, ...o });
const said = (r: Rig, at = 1) => toolResults(r.fake.requests[at]!.body).map((x) => x.content);
const ofType = <T extends EngineEvent['type']>(ev: EngineEvent[], type: T) => ev.filter((e): e is Extract<EngineEvent, { type: T }> => e.type === type);
const approvals = (ev: EngineEvent[]) => ofType(ev, 'hook').filter((e) => e.event === 'approve');
const put = (dir: string, rel: string, text: string) => {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
};
const link = (target: string, at: string, type: 'dir' | 'file'): string | undefined => {
  try {
    fs.symlinkSync(target, at, type === 'dir' && win ? 'junction' : type);
    return undefined;
  } catch (e) {
    return `links cannot be created here (${(e as Error).message})`;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (ok()) return true;
  return ok();
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
};
/** A command that writes marker.txt in the cwd, and one that prints hi, in the shell of this platform. */
const MARK = win ? 'Set-Content -Path marker.txt -Value x' : 'echo x > marker.txt';
const HI = win ? 'Write-Output hi' : 'echo hi';
const node = (script: string, ...args: string[]) => `${win ? '& $env:NODE' : '"$NODE"'} '${path.join(scripts, script)}'${args.map((a) => ` '${a}'`).join('')}`;

describe('the shell asks (4.5 step 4)', () => {
  it('asks with the tool, the raw input and the id; allow runs the command; the approve event follows the answer', async () => {
    const onApprove = vi.fn(ALLOW);
    const r = await make();
    r.push(calls(call('a', SHELL, { command: HI })), { text: 'ok' });
    const res = await (await start(r, { onApprove })).turn('go');
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith({ tool: SHELL, input: { command: HI }, id: 'a' });
    expect(said(r)[0]).toMatch(/^hi\r?\nexit 0$/);
    expect(approvals(res.events!)).toEqual([{ type: 'hook', event: 'approve', tool: SHELL, decision: 'allow' }]);
  }, 60_000);

  it('the host\'s onApprove is used when the session options have none', async () => {
    const onApprove = vi.fn(DENY);
    const r = await make('openai-chat', { host: { onApprove } });
    r.push(calls(call('a', SHELL, { command: MARK })), { text: 'ok' });
    await (await start(r)).turn('go');
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(cwd, 'marker.txt'))).toBe(false);
  });

  it('a no: the command does not run, the result is the message, the hook says deny, and no refusal is counted', async () => {
    const r = await make();
    r.push(calls(call('a', SHELL, { command: MARK })), { text: 'ok' });
    const res = await (await start(r, { onApprove: DENY })).turn('go');
    expect(fs.existsSync(path.join(cwd, 'marker.txt'))).toBe(false);
    expect(said(r)).toEqual([NO]);
    expect(approvals(res.events!)).toEqual([{ type: 'hook', event: 'approve', tool: SHELL, decision: 'deny', reason: NO }]);
    expect(ofType(res.events!, 'refusal')).toHaveLength(0);
    expect(ofType(res.events!, 'hook').filter((e) => e.event === 'pre-tool')).toHaveLength(0);
    expect(ofType(res.events!, 'tool_result')).toEqual([{ type: 'tool_result', tool: SHELL, output: NO }]);
  });

  it('a no with no message uses the default words', async () => {
    const r = await make();
    r.push(calls(call('a', SHELL, { command: MARK })), { text: 'ok' });
    const res = await (await start(r, { onApprove: async () => ({ behavior: 'deny' }) })).turn('go');
    expect(said(r)).toEqual([DEFAULT_DENY]);
    expect(approvals(res.events!)).toEqual([{ type: 'hook', event: 'approve', tool: SHELL, decision: 'deny' }]);
    expect(fs.existsSync(path.join(cwd, 'marker.txt'))).toBe(false);
  });
});

describe('a file tool outside the project asks, with the reason', () => {
  it('Read, Write and Edit outside ask with reason; the same tools inside the project do not', async () => {
    const onApprove = vi.fn(ALLOW);
    put(outside, 's.txt', 'SECRET\n');
    put(outside, 'e.txt', 'one\n');
    put(cwd, 'in.txt', 'inside\n');
    const r = await make();
    const rd = path.join('..', 'outside', 's.txt');
    const wr = path.join(outside, 'w.txt');
    const ed = path.join(outside, 'e.txt');
    r.push(
      calls(
        call('a', 'Read', { file_path: rd }), call('b', 'Write', { file_path: wr, content: 'W' }), call('c', 'Edit', { file_path: ed, old_string: 'one', new_string: 'two' }),
        call('d', 'Read', { file_path: 'in.txt' }), call('e', 'Write', { file_path: 'w-in.txt', content: 'I' }),
      ),
      { text: 'ok' },
    );
    await (await start(r, { onApprove })).turn('go');
    expect(onApprove.mock.calls.map(([q]) => q)).toEqual([
      { tool: 'Read', input: { file_path: rd }, id: 'a', reason: outsideOf(path.join(outside, 's.txt')) },
      { tool: 'Write', input: { file_path: wr, content: 'W' }, id: 'b', reason: outsideOf(wr) },
      { tool: 'Edit', input: { file_path: ed, old_string: 'one', new_string: 'two' }, id: 'c', reason: outsideOf(ed) },
    ]);
    expect(said(r)[0]).toContain('SECRET');
    expect(fs.readFileSync(wr, 'utf8')).toBe('W');
    expect(fs.readFileSync(ed, 'utf8')).toBe('two\n');
    expect(said(r)[3]).toBe('     1\tinside');
    expect(fs.readFileSync(path.join(cwd, 'w-in.txt'), 'utf8')).toBe('I');
  });

  it('a no does not write outside', async () => {
    const r = await make();
    const wr = path.join(outside, 'w.txt');
    r.push(calls(call('a', 'Write', { file_path: wr, content: 'W' })), { text: 'ok' });
    const res = await (await start(r, { onApprove: DENY })).turn('go');
    expect(fs.existsSync(wr)).toBe(false);
    expect(said(r)).toEqual([NO]);
    expect(ofType(res.events!, 'refusal')).toHaveLength(0);
  });

  describe('Glob and Grep: after a yes the search stays in the approved path', () => {
    const onApprove = vi.fn(ALLOW);
    let tgt = '';
    beforeEach(() => {
      onApprove.mockClear();
      tgt = path.join(outside, 'tgt');
      put(tgt, 'a.txt', 'needle a\n');
      put(tgt, 'sub/c.txt', 'needle c\n');
      put(outside, 'sib/b.txt', 'needle b\n');
      put(cwd, 'own.txt', 'needle own\n');
    });

    it('ask with the reason, list only files under the approved path, relative to it', async () => {
      const r = await make();
      r.push(calls(call('a', 'Glob', { pattern: '**/*.txt', path: tgt }), call('b', 'Grep', { pattern: 'needle', path: tgt })), { text: 'ok' });
      await (await start(r, { onApprove })).turn('go');
      expect(onApprove.mock.calls.map(([q]) => q)).toEqual([
        { tool: 'Glob', input: { pattern: '**/*.txt', path: tgt }, id: 'a', reason: outsideOf(tgt) },
        { tool: 'Grep', input: { pattern: 'needle', path: tgt }, id: 'b', reason: outsideOf(tgt) },
      ]);
      expect(said(r)).toEqual(['a.txt\nsub/c.txt', 'a.txt:1:needle a\nsub/c.txt:1:needle c']);
    });

    it('a single approved file is shown by its name', async () => {
      const r = await make();
      r.push(calls(call('a', 'Grep', { pattern: 'needle', path: path.join(tgt, 'a.txt') })), { text: 'ok' });
      await (await start(r, { onApprove })).turn('go');
      expect(said(r)).toEqual(['a.txt:1:needle a']);
    });

    it('a link inside the approved path is not followed', async (t) => {
      const why = link(path.join(outside, 'sib'), path.join(tgt, 'jump'), 'dir');
      if (why) return t.skip(`SKIPPED: ${why}`);
      const r = await make();
      r.push(calls(call('a', 'Glob', { pattern: '**/*.txt', path: tgt }), call('b', 'Grep', { pattern: 'needle', path: tgt })), { text: 'ok' });
      await (await start(r, { onApprove })).turn('go');
      expect(said(r)).toEqual(['a.txt\nsub/c.txt', 'a.txt:1:needle a\nsub/c.txt:1:needle c']);
    });

    it('the Reins home inside the approved path is never entered nor listed', async () => {
      const home = path.join(tgt, '.reins');
      put(home, 'secrets.json', 'needle secret\n');
      const r = await make('openai-chat', { host: { home } });
      const seen: string[] = [];
      const real = fs.readdirSync;
      vi.spyOn(fs, 'readdirSync').mockImplementation(((p: string, ...rest: unknown[]) => {
        seen.push(String(p));
        return (real as (...a: unknown[]) => unknown)(p, ...rest);
      }) as unknown as typeof fs.readdirSync);
      r.push(calls(call('a', 'Glob', { pattern: '**', path: tgt }), call('b', 'Grep', { pattern: 'needle', path: tgt })), { text: 'ok' });
      await (await start(r, { onApprove })).turn('go');
      expect(said(r)).toEqual(['a.txt\nsub/c.txt', 'a.txt:1:needle a\nsub/c.txt:1:needle c']);
      expect(seen.filter((p) => p.toLowerCase().startsWith(home.toLowerCase()))).toEqual([]);
      expect(seen.some((p) => p.toLowerCase() === tgt.toLowerCase())).toBe(true);
    });

    it('a search inside the project does not ask, and stays in the project', async () => {
      const r = await make();
      r.push(calls(call('a', 'Grep', { pattern: 'needle' })), { text: 'ok' });
      await (await start(r, { onApprove })).turn('go');
      expect(onApprove).not.toHaveBeenCalled();
      expect(said(r)).toEqual(['own.txt:1:needle own']);
    });
  });
});

describe('an auto-approving host changes no guard', () => {
  it('the Reins home stays refused, the word scan still refuses, and nothing is asked', async () => {
    const onApprove = vi.fn(ALLOW);
    const r = await make();
    r.push(
      calls(
        call('a', 'Read', { file_path: path.join(r.host.home, 'secrets.json') }), call('b', 'Write', { file_path: path.join(r.host.home, 'x.txt'), content: 'x' }),
        call('c', SHELL, { command: `cat ${path.join(r.host.home, 'secrets.json')}` }), call('d', 'Grep', { pattern: 'x', path: r.host.home }),
      ),
      { text: 'ok' },
    );
    const res = await (await start(r, { onApprove })).turn('go');
    expect(onApprove).not.toHaveBeenCalled();
    expect(said(r)).toEqual([HOME_WORDS, HOME_WORDS, HOME_NAMED_WORDS, HOME_WORDS]);
    expect(fs.existsSync(path.join(r.host.home, 'x.txt'))).toBe(false);
    expect(ofType(res.events!, 'refusal')).toHaveLength(4);
  });

  it('checkTool still denies before any question: read-only mode, a guard, a shell step with no shell', async () => {
    const onApprove = vi.fn(ALLOW);
    put(cwd, 'migrations/1.sql', 'old');
    const r = await make();
    r.push(
      calls(call('a', 'Write', { file_path: path.join(outside, 'o.txt'), content: 'x' }), call('b', SHELL, { command: MARK }), call('c', 'Write', { file_path: 'migrations/1.sql', content: 'new' })),
      { text: 'ok' },
    );
    await (await start(r, { onApprove }, { mode: 'read-only', guards: ['migrations/**'], allowShell: false })).turn('go');
    expect(onApprove).not.toHaveBeenCalled();
    expect(said(r)[0]).toContain('this step is read-only');
    expect(said(r)[1]).toContain('shell commands are blocked');
    expect(said(r)[2]).toContain('this step is read-only');
    expect(fs.existsSync(path.join(outside, 'o.txt'))).toBe(false);
    expect(fs.existsSync(path.join(cwd, 'marker.txt'))).toBe(false);

    const g = await make();
    g.push(calls(call('a', 'Write', { file_path: 'migrations/1.sql', content: 'new' }), call('b', SHELL, { command: 'cat migrations/1.sql' })), { text: 'ok' });
    await (await start(g, { onApprove }, { mode: 'write', guards: ['migrations/**'], allowShell: true })).turn('go');
    expect(said(g)[0]).toContain('is guarded (migrations/**)');
    expect(said(g)[1]).toContain('guarded');
    expect(onApprove).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(cwd, 'migrations', '1.sql'), 'utf8')).toBe('old');
  });

  it('the refusal of a bad path and an unknown tool comes before the question too', async () => {
    const onApprove = vi.fn(ALLOW);
    const r = await make();
    r.push(calls(call('a', 'Read', { file_path: '../outside/nul.txt' }), call('b', 'Patch', {}), call('c', SHELL, {})), { text: 'ok' });
    await (await start(r, { onApprove })).turn('go');
    expect(onApprove).not.toHaveBeenCalled();
  });
});

describe('questions come one at a time, in the model\'s order', () => {
  it('a second question waits for the first; a read between them waits too', async () => {
    put(outside, 'a.txt', 'A');
    put(outside, 'b.txt', 'B');
    put(cwd, 'in.txt', 'I');
    const log: string[] = [];
    const real = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: string, ...rest: unknown[]) => {
      log.push(`open ${path.basename(String(p))}`);
      return (real as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.promises.open);
    const onApprove = async (q: ToolRequest): Promise<Decision> => {
      log.push(`ask ${q.id}`);
      await sleep(q.id === 'a' ? 150 : 10);
      log.push(`answer ${q.id}`);
      return { behavior: 'allow' };
    };
    const r = await make();
    r.push(calls(call('a', 'Read', { file_path: path.join(outside, 'a.txt') }), call('m', 'Read', { file_path: 'in.txt' }), call('b', 'Read', { file_path: path.join(outside, 'b.txt') })), { text: 'ok' });
    await (await start(r, { onApprove })).turn('go');
    expect(log.filter((l) => /^(ask|answer) /.test(l) || l === 'open in.txt')).toEqual(['ask a', 'answer a', 'open in.txt', 'ask b', 'answer b']);
    expect(said(r)).toEqual(['     1\tA', '     1\tI', '     1\tB']);
  });

  it('a path through a link that leads outside asks like any other, after the one before it', async (t) => {
    put(cwd, 'sub/f.txt', 'F');
    put(outside, 'f.txt', 'OUT');
    const why = link(outside, path.join(cwd, 'swap'), 'dir');
    if (why) return t.skip(`SKIPPED: ${why}`);
    const r = await make();
    // 'swap' leads outside: the second call asks as well, and is asked after the first answer.
    const order: string[] = [];
    const onApprove = vi.fn(async (q: ToolRequest): Promise<Decision> => {
      order.push(q.id!);
      return { behavior: 'allow' };
    });
    r.push(calls(call('a', 'Read', { file_path: path.join(outside, 'f.txt') }), call('b', 'Read', { file_path: 'swap/f.txt' })), { text: 'ok' });
    await (await start(r, { onApprove })).turn('go');
    expect(order).toEqual(['a', 'b']);
    // A project link that points outside shows where it really leads.
    expect(onApprove.mock.calls[1]![0].reason).toBe(outsideOf(path.join(outside, 'f.txt')));
  });
});

describe('fail closed', () => {
  const internal = /^Blocked by Reins: internal error \(.*\)\.$/s;
  it.each([
    ['throws', async (): Promise<Decision> => { throw new Error('boom'); }, 'boom'],
    ['throws at once', (() => { throw new Error('sync boom'); }) as unknown as () => Promise<Decision>, 'sync boom'],
    ['rejects', () => Promise.reject(new Error('nope')), 'nope'],
    ['answers nonsense', (async () => ({ behavior: 'maybe' })) as unknown as () => Promise<Decision>, 'the answer was not allow or deny'],
    ['answers nothing', (async () => undefined) as unknown as () => Promise<Decision>, 'the answer was not allow or deny'],
  ])('onApprove %s: a deny with the internal-error words, the tool does not run, the turn goes on', async (_n, onApprove, what) => {
    const r = await make();
    r.push(calls(call('a', SHELL, { command: MARK }), call('b', 'Write', { file_path: path.join(outside, 'w.txt'), content: 'x' })), { text: 'ok' });
    const res = await (await start(r, { onApprove })).turn('go');
    expect(res.text).toBe('ok');
    expect(said(r)).toEqual([`Blocked by Reins: internal error (${what}).`, `Blocked by Reins: internal error (${what}).`]);
    expect(fs.existsSync(path.join(cwd, 'marker.txt'))).toBe(false);
    expect(fs.existsSync(path.join(outside, 'w.txt'))).toBe(false);
    expect(approvals(res.events!)).toEqual([SHELL, 'Write'].map((tool) => ({ type: 'hook', event: 'approve', tool, decision: 'deny', reason: `Blocked by Reins: internal error (${what}).` })));
    expect(ofType(res.events!, 'refusal')).toHaveLength(0);
  });

  it('the message is redacted and cut to 200 characters', async () => {
    const r = await make();
    r.push(calls(call('a', SHELL, { command: MARK }), call('b', SHELL, { command: MARK })), { text: 'ok' });
    let n = 0;
    const onApprove = async (): Promise<Decision> => {
      throw new Error(n++ === 0 ? `bad ${KEY} here` : 'x'.repeat(500));
    };
    await (await start(r, { onApprove })).turn('go');
    const [first, second] = said(r);
    expect(first).not.toContain(KEY);
    expect(first).toContain('[key Reins]');
    expect(first).toMatch(internal);
    expect(second!.length).toBeLessThanOrEqual('Blocked by Reins: internal error ().'.length + 200);
    expect(second).toMatch(internal);
  });
});

describe('interrupt', () => {
  it('during a running shell command: the turn ends within 1 s, the process tree is gone, the call is stubbed', async () => {
    const pids = path.join(tmp, 'pids.txt');
    const r = await make();
    r.push(calls(call('a', SHELL, { command: node('tree.js', pids) })));
    const s = await start(r, { onApprove: ALLOW });
    const turn = s.turn('go');
    expect(await until(() => fs.existsSync(pids) && fs.readFileSync(pids, 'utf8') !== '', 30_000)).toBe(true);
    const [own, child] = fs.readFileSync(pids, 'utf8').trim().split(' ').map(Number) as [number, number];
    const at = Date.now();
    await s.interrupt();
    const res = await turn;
    expect(Date.now() - at).toBeLessThan(1000);
    expect(res.text).toBe('');
    expect(res.isError).toBeUndefined();
    expect(res.events).toContainEqual({ type: 'tool_result', tool: SHELL, output: INTERRUPTED });
    expect(await until(() => !alive(own) && !alive(child), 5000)).toBe(true);
    r.push({ text: 'again' });
    expect((await s.turn('hi')).text).toBe('again');
    expect(toolResults(r.fake.requests[1]!.body)).toEqual([{ id: 'a', content: INTERRUPTED }]);
  }, 90_000);

  it('during a pending question: ends within 1 s, the question is void, a late yes runs nothing, a new turn is well paired', async () => {
    const wr = path.join(outside, 'late.txt');
    const r = await make();
    r.push(calls(call('a', 'Write', { file_path: wr, content: 'late' }), call('b', 'Read', { file_path: 'nothing.txt' })));
    let answer!: (d: Decision) => void;
    let asked = 0;
    const onApprove = () => {
      asked++;
      return new Promise<Decision>((ok) => { answer = ok; });
    };
    const queued = ['stays queued'];
    const pendingCards = vi.fn(() => queued.splice(0));
    const s = await start(r, { onApprove, pendingCards });
    const turn = s.turn('go');
    expect(await until(() => asked === 1, 5000)).toBe(true);
    const at = Date.now();
    await s.interrupt();
    const res = await turn;
    expect(Date.now() - at).toBeLessThan(1000);
    // No call finished, and the cards stay with the host.
    expect(pendingCards).not.toHaveBeenCalled();
    expect(queued).toEqual(['stays queued']);
    expect(res.text).toBe('');
    expect(res.events).toContainEqual({ type: 'tool_result', tool: 'Write', output: INTERRUPTED });
    expect(res.events).toContainEqual({ type: 'tool_result', tool: 'Read', output: INTERRUPTED });
    expect(approvals(res.events!)).toEqual([]);
    // The host closes a tool question when the turn ends (session.ts closeQuestions): its answer is then a deny. A yes that comes later is no better.
    answer({ behavior: 'allow' });
    await sleep(150);
    expect(fs.existsSync(wr)).toBe(false);
    expect(asked).toBe(1);
    expect(approvals(r.live)).toEqual([]);
    r.push({ text: 'again' });
    expect((await s.turn('hi')).text).toBe('again');
    expect(toolResults(r.fake.requests[1]!.body)).toEqual([{ id: 'a', content: INTERRUPTED }, { id: 'b', content: INTERRUPTED }]);
  });

  it('a question that rejects after the interrupt does not crash the process', async () => {
    const r = await make();
    r.push(calls(call('a', 'Write', { file_path: path.join(outside, 'late.txt'), content: 'late' })));
    let fail!: (e: Error) => void;
    let asked = 0;
    const s = await start(r, { onApprove: () => { asked++; return new Promise<Decision>((_ok, no) => { fail = no; }); } });
    const turn = s.turn('go');
    expect(await until(() => asked === 1, 5000)).toBe(true);
    await s.interrupt();
    await turn;
    fail(new Error('late failure'));
    await sleep(100);
    expect(fs.existsSync(path.join(outside, 'late.txt'))).toBe(false);
  });
});

describe.each(WIRES)('cards in the middle of a turn, on %s', (wireId) => {
  const MISSING = 'no-such-file.txt';
  const read = (id: string) => call(id, 'Read', { file_path: MISSING });
  const systemOf = (body: any): string => (wireId === 'openai-chat' ? body.messages[0].content : body.system);
  const nonceOf = (body: any) => /REINS CARD ([0-9a-f]{32})/.exec(systemOf(body))![1]!;
  /** What the next request carries after the last assistant message, as `[role, text blocks]` per message. */
  const after = (body: any) => {
    const msgs = body.messages as any[];
    const i = msgs.map((m) => m.role).lastIndexOf('assistant');
    return msgs.slice(i + 1).map((m) => [m.role, Array.isArray(m.content) ? m.content.map((b: any) => b.type === 'tool_result' ? 'result' : b.text) : [m.content]] as const);
  };
  /** A rig whose pending cards are `queue`; a card is queued by `onTool` when the tools start. */
  const setup = async (queue: string[], onTool?: () => void) => {
    const r = await make(wireId);
    const pendingCards = vi.fn(() => queue.splice(0));
    const open = async (extra: Partial<OpenOptions> = {}) => {
      const s = await start(r, { onApprove: ALLOW, pendingCards, ...extra });
      r.host.onLive = (e) => {
        r.live.push(e);
        if (e.type === 'tool_call') onTool?.();
      };
      return s;
    };
    return { r, pendingCards, open };
  };

  it('a card queued during a tool reaches the next request after the result, wrapped with the session nonce', async () => {
    const queue: string[] = [];
    const { r, open } = await setup(queue, () => queue.push('please stop at 5'));
    r.push(calls(read('a')), { text: 'ok' });
    const res = await (await open()).turn('go');
    const body = r.fake.requests[1]!.body;
    const nonce = nonceOf(body);
    expect(nonceOf(r.fake.requests[0]!.body)).toBe(nonce);
    const card = wrapCard('please stop at 5', nonce);
    const tail = after(body);
    if (wireId === 'openai-chat') expect(tail).toEqual([['tool', [`File not found: ${MISSING}`]], ['user', [card]]]);
    else expect(tail).toEqual([['user', ['result', card]]]);
    expect(ofType(res.events!, 'card_delivered')).toEqual([{ type: 'card_delivered', card: 'please stop at 5', channel: 'mid-turn' }]);
    expect(ofType(res.events!, 'hook').filter((e) => e.event === 'post-tool')).toEqual([{ type: 'hook', event: 'post-tool', tool: 'Read', decision: 'card' }]);
    expect(toolResults(body)).toEqual([{ id: 'a', content: `File not found: ${MISSING}` }]);
  });

  it('a batch with no card says pass, and nothing is added', async () => {
    const { r, open } = await setup([]);
    r.push(calls(read('a')), { text: 'ok' });
    const res = await (await open()).turn('go');
    expect(ofType(res.events!, 'hook').filter((e) => e.event === 'post-tool')).toEqual([{ type: 'hook', event: 'post-tool', tool: 'Read', decision: 'pass' }]);
    expect(ofType(res.events!, 'card_delivered')).toEqual([]);
    expect(after(r.fake.requests[1]!.body).flatMap(([, texts]) => texts).filter((x) => x !== 'result' && !String(x).startsWith('File'))).toEqual([]);
  });

  it('two cards in one batch: each once, in order, in the same user message', async () => {
    const queue: string[] = [];
    const { r, open } = await setup(queue, () => { if (!queue.length) queue.push('first', 'second'); });
    r.push(calls(read('a'), read('b')), { text: 'ok' });
    const res = await (await open()).turn('go');
    const body = r.fake.requests[1]!.body;
    const nonce = nonceOf(body);
    const tail = after(body);
    if (wireId === 'openai-chat') expect(tail).toEqual([['tool', [`File not found: ${MISSING}`]], ['tool', [`File not found: ${MISSING}`]], ['user', [`${wrapCard('first', nonce)}\n\n${wrapCard('second', nonce)}`]]]);
    else expect(tail).toEqual([['user', ['result', 'result', wrapCard('first', nonce), wrapCard('second', nonce)]]]);
    expect(ofType(res.events!, 'card_delivered').map((e) => e.card)).toEqual(['first', 'second']);
    expect(ofType(res.events!, 'hook').filter((e) => e.event === 'post-tool')).toHaveLength(1);
  });

  it('a card over the budget is cut', async () => {
    const queue: string[] = [];
    const { r, open } = await setup(queue, () => queue.push('x'.repeat(20_000)));
    r.push(calls(read('a')), { text: 'ok' });
    await (await open()).turn('go');
    const body = r.fake.requests[1]!.body;
    const sent = JSON.stringify(body);
    expect(sent).toContain(`${'x'.repeat(9600)} […cut]`);
    expect(sent).not.toContain('x'.repeat(9601));
  });

  it('a card is wrapped with the nonce of the session, which is stable across turns and different between sessions', async () => {
    const queue: string[] = [];
    const { r, open } = await setup(queue, () => { if (!queue.length) queue.push('c'); });
    r.push(calls(read('a')), { text: 'ok' }, calls(read('b')), { text: 'ok2' });
    const s = await open();
    await s.turn('one');
    await s.turn('two');
    const n1 = nonceOf(r.fake.requests[1]!.body);
    expect(nonceOf(r.fake.requests[3]!.body)).toBe(n1);
    expect(JSON.stringify(r.fake.requests[3]!.body)).toContain(JSON.stringify(wrapCard('c', n1)).slice(1, -1));
    r.push({ text: 'x' });
    await (await open()).turn('other');
    expect(nonceOf(r.fake.requests[4]!.body)).not.toBe(n1);
  });

  it('an interrupted batch does not drain the cards, and says nothing about them', async () => {
    const queue = ['kept'];
    const { r, pendingCards, open } = await setup(queue);
    r.push(calls(call('1', 'Write', { file_path: 'w1.txt', content: '1' }), call('2', 'Write', { file_path: 'w2.txt', content: '2' })), { text: 'ok' });
    const s = await open();
    const live = r.host.onLive;
    r.host.onLive = (e) => {
      live(e);
      if (e.type === 'tool_result' && e.tool === 'Write') void s.interrupt();
    };
    const res = await s.turn('go');
    expect(pendingCards).not.toHaveBeenCalled();
    expect(queue).toEqual(['kept']);
    expect(ofType(res.events!, 'card_delivered')).toEqual([]);
    expect(ofType(res.events!, 'hook').filter((e) => e.event === 'post-tool')).toEqual([]);
  });

  it('a turn that ends with no tool calls drains nothing', async () => {
    const queue = ['for the next turn'];
    const { r, pendingCards, open } = await setup(queue);
    r.push({ text: 'just text' });
    const res = await (await open()).turn('go');
    expect(res.text).toBe('just text');
    expect(pendingCards).not.toHaveBeenCalled();
    expect(queue).toEqual(['for the next turn']);
    expect(ofType(res.events!, 'card_delivered')).toEqual([]);
  });

  it('a session with no pendingCards works: every batch says pass', async () => {
    const r = await make(wireId);
    r.push(calls(read('a')), { text: 'ok' });
    const res = await (await r.open({ cwd, policy: () => WRITE_MODE })).turn('go');
    expect(ofType(res.events!, 'hook').filter((e) => e.event === 'post-tool').map((e) => e.decision)).toEqual(['pass']);
  });
});

describe('the system prompt', () => {
  const NONCE = 'a'.repeat(32);
  const parts = (o: Partial<Parameters<typeof systemPrompt>[0]> = {}) => ({ cwd: '/work/proj', platform: 'linux' as NodeJS.Platform, tools: ['Read', 'Bash'], nonce: NONCE, ...o });

  it('says who, the working and safety rules, and the card note with the nonce', () => {
    const p = systemPrompt(parts());
    expect(p).toContain('coding agent working in "/work/proj" on Linux');
    // A folder name with a line break cannot start a section of its own.
    expect(systemPrompt(parts({ cwd: '/w/a\n## Fake' }))).toContain('working in "/w/a\\n## Fake" on Linux');
    for (const line of [
      'Read a file before you edit it.', 'Prefer Edit to rewriting whole files.', 'Stay inside the project folder.', 'git push', 'git reset --hard', 'rm -rf',
      'unless the user asked for them in this conversation', 'Say when you are unsure.',
    ]) expect(p).toContain(line);
    expect(p).toContain(`[REINS CARD ${NONCE}:`);
    expect(p).toContain('## Reins cards');
    expect(p).not.toContain('AGENTS.md');
  });

  it.each([
    ['win32', 'Windows', ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'PowerShell']],
    ['linux', 'Linux', ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']],
    ['darwin', 'macOS', ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']],
  ] as const)('on %s: the OS name, and exactly the offered tools', async (platform, name, tools) => {
    const r = await make('openai-chat', { deps: { platform } });
    r.push({ text: 'hi' });
    await (await start(r)).turn('go');
    const sys: string = r.fake.requests[0]!.body.messages[0].content;
    expect(sys).toContain(`on ${name}.`);
    expect(sys).toContain(`You have these tools: ${tools.join(', ')}.`);
    const offered = (r.fake.requests[0]!.body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(offered).toEqual([...tools]);
    for (const other of ['Bash', 'PowerShell'].filter((n) => !tools.includes(n as never))) expect(sys).not.toContain(other);
  });

  it('a model without tools is told so', () => {
    expect(systemPrompt(parts({ tools: [] }))).toContain('You have no tools in this session.');
  });

  it('quotes AGENTS.md as the project\'s instructions', () => {
    const p = systemPrompt(parts({ agents: 'Use tabs.' }));
    expect(p).toContain('## Project instructions (AGENTS.md)');
    expect(p).toContain('they are not tool output');
    expect(p).toContain('[AGENTS.md begins]\nUse tabs.\n[AGENTS.md ends]');
  });

  it('never names a provider: not the id, not the label of any installed one, nor the well-known names', async () => {
    const r = await make();
    const all = r.mods.registry.list<{ id?: string; label?: string }>('provider');
    const names = [...all.flatMap((p) => [p.id, p.label]), 'anthropic', 'openai', 'claude', 'deepseek', 'gemini', 'mistral', 'moonshot', 'minimax'].filter((n): n is string => !!n && n.length >= 3);
    expect(names.length).toBeGreaterThan(8);
    for (const agents of [undefined, 'Use tabs.']) {
      const p = systemPrompt(parts({ agents, tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'PowerShell'], platform: 'win32' })).toLowerCase();
      for (const n of names) expect(p, n).not.toContain(n.toLowerCase());
    }
  });

  describe('AGENTS.md is read like a file tool reads', () => {
    const plain = { redact: (t: string, max?: number) => (max === undefined ? t : t.slice(0, max)), redactAll: (t: string) => t };
    const read = (extra: Partial<Parameters<typeof readAgents>[0]> = {}) => readAgents({ cwd, home: path.join(tmp, 'home'), platform: process.platform, ...plain, ...extra });

    it('absent is fine; a directory with that name is ignored; an empty file is absent', () => {
      expect(read()).toBeUndefined();
      fs.mkdirSync(path.join(cwd, 'AGENTS.md'));
      expect(read()).toBeUndefined();
      fs.rmdirSync(path.join(cwd, 'AGENTS.md'));
      fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '  \n');
      expect(read()).toBeUndefined();
    });

    it('reads a regular file whole when it is short', () => {
      put(cwd, 'AGENTS.md', 'Use tabs.\n');
      expect(read()).toBe('Use tabs.\n');
    });

    it('cuts at 20,000 characters, never in the middle of a character, and says so', () => {
      put(cwd, 'AGENTS.md', 'a'.repeat(AGENTS_MAX + 5000));
      expect(read()).toBe('a'.repeat(AGENTS_MAX) + AGENTS_CUT);
      put(cwd, 'AGENTS.md', 'a'.repeat(AGENTS_MAX));
      expect(read()).toBe('a'.repeat(AGENTS_MAX));
      put(cwd, 'AGENTS.md', 'a' + '\u{1F600}'.repeat(15_000));
      const out = read()!;
      expect(out.endsWith(AGENTS_CUT)).toBe(true);
      expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out)).toBe(false);
    });

    it('is redacted before it is cut: a key is gone, and a key at the cut is not left in part', async () => {
      const r = await make();
      put(cwd, 'AGENTS.md', `Key is ${KEY}.\n` + 'b'.repeat(30_000));
      const out = readAgents({ cwd, home: r.host.home, platform: process.platform, redact: r.host.redact!, redactAll: r.host.redactAll! })!;
      expect(out).not.toContain(KEY);
      expect(out).toContain('[key Reins]');
      put(cwd, 'AGENTS.md', `Short file. Key is ${KEY}.\n`);
      const short = readAgents({ cwd, home: r.host.home, platform: process.platform, redact: r.host.redact!, redactAll: r.host.redactAll! })!;
      expect(short).not.toContain(KEY);
      expect(short).toBe('Short file. Key is [key Reins].\n');
      put(cwd, 'AGENTS.md', 'c'.repeat(AGENTS_MAX - 10) + KEY + 'd'.repeat(100));
      const cut = readAgents({ cwd, home: r.host.home, platform: process.platform, redact: r.host.redact!, redactAll: r.host.redactAll! })!;
      expect(cut).not.toContain(KEY.slice(0, 8));
    });

    it('goes through confine: a name that leads into the Reins home or outside the project is not read (fake fs)', () => {
      const home = path.join(tmp, 'home');
      put(home, 'x.md', 'HOME TEXT');
      put(outside, 'x.md', 'OUTSIDE TEXT');
      put(cwd, 'AGENTS.md', 'REGULAR TEXT');
      const leads = (to: string): FsLike => ({
        realpathSync: { native: (p: string) => (path.basename(p) === 'AGENTS.md' ? to : fs.realpathSync.native(p)) },
        lstatSync: (p: string) => fs.lstatSync(p),
      });
      expect(read({ home, fs: leads(path.join(home, 'x.md')) })).toBeUndefined();
      expect(read({ home, fs: leads(path.join(outside, 'x.md')) })).toBeUndefined();
      expect(read({ home })).toBe('REGULAR TEXT');
    });

    it('a symlink to a file of the Reins home, or outside the project, is not read', async (t) => {
      const home = path.join(tmp, 'home');
      const secret = put(home, 'x.md', 'HOME TEXT');
      const away = put(outside, 'x.md', 'OUTSIDE TEXT');
      const why = link(secret, path.join(cwd, 'AGENTS.md'), 'file');
      if (why) return t.skip(`SKIPPED: ${why}`);
      expect(read({ home })).toBeUndefined();
      fs.rmSync(path.join(cwd, 'AGENTS.md'));
      expect(link(away, path.join(cwd, 'AGENTS.md'), 'file')).toBeUndefined();
      expect(read({ home })).toBeUndefined();
    });

    it('a junction or link to a folder of the Reins home is not read', async (t) => {
      const home = path.join(tmp, 'home');
      put(home, 'x.md', 'HOME TEXT');
      const why = link(home, path.join(cwd, 'AGENTS.md'), 'dir');
      if (why) return t.skip(`SKIPPED: ${why}`);
      expect(read({ home })).toBeUndefined();
    });

    it('a second name (hard link) of a file of the Reins home is not read', (t) => {
      const home = path.join(tmp, 'home');
      const secret = put(home, 'x.md', 'HOME TEXT');
      try {
        fs.linkSync(secret, path.join(cwd, 'AGENTS.md'));
      } catch (e) {
        return t.skip(`SKIPPED: hard links cannot be created here (${(e as Error).message})`);
      }
      expect(read({ home })).toBeUndefined();
    });
  });

  describe('through the engine', () => {
    it('is in the request, redacted and cut, once per turn and not when the session opens', async () => {
      put(cwd, 'AGENTS.md', `Be brief. ${KEY}\n` + 'z'.repeat(25_000));
      const opens: string[] = [];
      const real = fs.openSync;
      vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        if (String(p).endsWith('AGENTS.md')) opens.push(String(p));
        return (real as (...a: unknown[]) => unknown)(p, ...rest);
      }) as typeof fs.openSync);
      const r = await make();
      r.push(calls(call('a', 'Read', { file_path: 'AGENTS.md' })), { text: 'ok' }, { text: 'again' });
      const s = await start(r);
      expect(opens).toEqual([]);
      await s.turn('go');
      // One read for the turn's two model calls (the Read tool opens files another way).
      expect(opens).toHaveLength(1);
      const sys0: string = r.fake.requests[0]!.body.messages[0].content;
      const sys1: string = r.fake.requests[1]!.body.messages[0].content;
      expect(sys1).toBe(sys0);
      expect(sys0).toContain('## Project instructions (AGENTS.md)');
      expect(sys0).toContain('Be brief. [key Reins]');
      expect(sys0).not.toContain(KEY);
      expect(sys0).toContain(`${'z'.repeat(100)}`);
      expect(sys0).not.toContain('z'.repeat(AGENTS_MAX));
      expect(sys0).toContain(AGENTS_CUT);
      await s.turn('hi');
      expect(opens).toHaveLength(2);
    });

    it('the card note in the prompt and the wrapper of a mid-turn card carry the same nonce', async () => {
      const queue = ['hello'];
      const r = await make();
      r.push(calls(call('a', 'Read', { file_path: 'nothing.txt' })), { text: 'ok' });
      await (await start(r, { pendingCards: () => queue.splice(0) })).turn('go');
      const nonce = /REINS CARD ([0-9a-f]{32})/.exec(r.fake.requests[0]!.body.messages[0].content)![1]!;
      expect(JSON.stringify(r.fake.requests[1]!.body)).toContain(JSON.stringify(wrapCard('hello', nonce)).slice(1, -1));
    });
  });
});

// ---- fix round (review of Task 13) ----------------------------------------------------------------------------------------------------

describe('the call is judged again after the yes', () => {
  const HOME_STANDIN = 'fakehome';
  /** A project file link to outside/slot/file.txt, and a Reins home stand-in. Undefined when links cannot be made here. */
  function setup(): { slot: string; fakeHome: string; skip?: string } {
    const slot = path.join(outside, 'slot');
    const fakeHome = path.join(tmp, HOME_STANDIN);
    put(slot, 'file.txt', 'old');
    put(fakeHome, 'file.txt', 'old');
    const why = link(path.join(slot, 'file.txt'), path.join(cwd, 'proj-link.txt'), 'file') ?? link(fakeHome, path.join(tmp, 'probe'), 'dir');
    return { slot, fakeHome, ...(why ? { skip: `SKIPPED: ${why}` } : {}) };
  }
  /** Replaces the folder `slot` by a link to `to`, as another process could while the question is open. */
  const swap = (slot: string, to: string) => {
    fs.renameSync(slot, `${slot}-old`);
    expect(link(to, slot, 'dir')).toBeUndefined();
  };

  for (const tool of ['Write', 'Edit'] as const) {
    it(`${tool}: a folder swapped for a link to the Reins home while the question is open does not land there`, async (t) => {
      const { slot, fakeHome, skip } = setup();
      if (skip) return t.skip(skip);
      const r = await make('openai-chat', { host: { home: fakeHome } });
      const input = tool === 'Write' ? { file_path: 'proj-link.txt', content: 'EVIL' } : { file_path: 'proj-link.txt', old_string: 'old', new_string: 'EVIL' };
      r.push(calls(call('a', tool, input)), { text: 'ok' });
      const onApprove = async (): Promise<Decision> => {
        swap(slot, fakeHome);
        return { behavior: 'allow' };
      };
      const res = await (await start(r, { onApprove })).turn('go');
      expect(fs.readFileSync(path.join(fakeHome, 'file.txt'), 'utf8')).toBe('old');
      expect(said(r)).toEqual([HOME_WORDS]);
      expect(ofType(res.events!, 'refusal').map((e) => e.reason)).toEqual([HOME_WORDS]);
      expect(res.events).toContainEqual({ type: 'hook', event: 'pre-tool', tool, decision: 'deny', reason: HOME_WORDS });
    });
  }

  it('a folder swapped for a link to a folder of the project: the question was about something else, so it does not run', async (t) => {
    const { slot, fakeHome, skip } = setup();
    if (skip) return t.skip(skip);
    put(cwd, 'inner/f.txt', 'INNER');
    put(slot, 'f.txt', 'ASKED');
    const r = await make('openai-chat', { host: { home: fakeHome } });
    r.push(calls(call('a', 'Read', { file_path: path.join(slot, 'f.txt') })), { text: 'ok' });
    const res = await (await start(r, { onApprove: async () => (swap(slot, path.join(cwd, 'inner')), { behavior: 'allow' as const }) })).turn('go');
    expect(said(r)).toEqual(['Blocked by Reins: the path changed while the question was open.']);
    expect(ofType(res.events!, 'refusal')).toHaveLength(1);
    expect(res.events).toContainEqual({ type: 'hook', event: 'pre-tool', tool: 'Read', decision: 'deny', reason: said(r)[0] });
  });

  it('a folder swapped for a link to another folder outside: a different destination, so it does not run', async (t) => {
    const { slot, fakeHome, skip } = setup();
    if (skip) return t.skip(skip);
    put(outside, 'other/f.txt', 'OTHER');
    put(slot, 'f.txt', 'ASKED');
    const r = await make('openai-chat', { host: { home: fakeHome } });
    r.push(calls(call('a', 'Read', { file_path: path.join(slot, 'f.txt') })), { text: 'ok' });
    await (await start(r, { onApprove: async () => (swap(slot, path.join(outside, 'other')), { behavior: 'allow' as const }) })).turn('go');
    expect(said(r)).toEqual(['Blocked by Reins: the path changed while the question was open.']);
  });

  it('nothing changed: the call runs after the yes', async () => {
    const r = await make();
    const wr = path.join(outside, 'same.txt');
    r.push(calls(call('a', 'Write', { file_path: wr, content: 'S' }), call('b', SHELL, { command: HI })), { text: 'ok' });
    await (await start(r, { onApprove: ALLOW })).turn('go');
    expect(fs.readFileSync(wr, 'utf8')).toBe('S');
    expect(said(r)[1]).toMatch(/^hi\r?\nexit 0$/);
  }, 60_000);

  it('the policy switched to read-only while the question is open: denied after the yes, in the policy\'s words', async () => {
    let policy: Policy = WRITE_MODE;
    const r = await make();
    const wr = path.join(outside, 'p.txt');
    r.push(calls(call('a', 'Write', { file_path: wr, content: 'P' }), call('b', SHELL, { command: MARK })), { text: 'ok' });
    const onApprove = async (): Promise<Decision> => {
      policy = { mode: 'read-only', guards: [], allowShell: false };
      return { behavior: 'allow' };
    };
    const res = await (await start(r, { onApprove, policy: () => policy })).turn('go');
    expect(fs.existsSync(wr)).toBe(false);
    expect(fs.existsSync(path.join(cwd, 'marker.txt'))).toBe(false);
    expect(said(r)[0]).toContain('this step is read-only');
    expect(said(r)[1]).toContain('shell commands are blocked');
    expect(ofType(res.events!, 'refusal')).toHaveLength(2);
  });
});

describe('an interrupt at the moment of the answer', () => {
  it.each([
    ['Write', () => ({ file_path: path.join(outside, 'x.txt'), content: 'X' }), () => path.join(outside, 'x.txt')],
    ['Edit', () => ({ file_path: path.join(outside, 'e.txt'), old_string: 'one', new_string: 'two' }), () => path.join(outside, 'e.txt')],
    [SHELL, () => ({ command: MARK }), () => path.join(cwd, 'marker.txt')],
  ] as const)('%s: when the turn is aborted by the approve event, the tool does not start; the call is stubbed and a new turn works', async (tool, input, marker) => {
    put(outside, 'e.txt', 'one\n');
    const r = await make();
    r.push(calls(call('a', tool, input())));
    const s = await start(r, { onApprove: ALLOW });
    r.host.onLive = (e) => {
      r.live.push(e);
      if (e.type === 'hook' && e.event === 'approve' && e.decision === 'allow') void s.interrupt();
    };
    const res = await s.turn('go');
    await sleep(200);
    expect(res.text).toBe('');
    expect(res.events).toContainEqual({ type: 'tool_result', tool, output: INTERRUPTED });
    if (tool === 'Edit') expect(fs.readFileSync(marker(), 'utf8')).toBe('one\n');
    else expect(fs.existsSync(marker())).toBe(false);
    r.host.onLive = (e) => void r.live.push(e);
    r.push({ text: 'again' });
    expect((await s.turn('hi')).text).toBe('again');
    expect(toolResults(r.fake.requests[1]!.body)).toEqual([{ id: 'a', content: INTERRUPTED }]);
  }, 60_000);
});

describe('files are opened without blocking', () => {
  const want = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

  it('both readers open read-only and non-blocking where the platform has O_NONBLOCK', async () => {
    put(cwd, 'AGENTS.md', 'Be brief.\n');
    put(cwd, 'in.txt', 'inside\n');
    const sync: unknown[] = [];
    const wide: unknown[] = [];
    const realSync = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags: unknown, ...rest: unknown[]) => {
      if (String(p).endsWith('AGENTS.md')) sync.push(flags);
      return (realSync as (...a: unknown[]) => unknown)(p, flags, ...rest);
    }) as typeof fs.openSync);
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: string, flags: unknown, ...rest: unknown[]) => {
      if (String(p).endsWith('in.txt')) wide.push(flags);
      return (realOpen as (...a: unknown[]) => unknown)(p, flags, ...rest);
    }) as typeof fs.promises.open);
    const r = await make();
    r.push(calls(call('a', 'Read', { file_path: 'in.txt' })), { text: 'ok' });
    await (await start(r)).turn('go');
    expect(sync).toEqual([want]);
    expect(wide).toEqual([want]);
    if (fs.constants.O_NONBLOCK === undefined) console.log('NOTE: this platform has no O_NONBLOCK, so the flags are plain O_RDONLY; the FIFO case is POSIX-only');
  });

  it('a FIFO named AGENTS.md does not stop the turn from starting (POSIX)', async (t) => {
    if (win) return t.skip('SKIPPED: FIFOs need mkfifo, which Windows does not have; the flags test above covers the open call here');
    try {
      execFileSync('mkfifo', [path.join(cwd, 'AGENTS.md')]);
    } catch (e) {
      return t.skip(`SKIPPED: mkfifo failed (${(e as Error).message})`);
    }
    const r = await make();
    r.push({ text: 'hi' });
    const began = Date.now();
    await (await start(r)).turn('go');
    expect(Date.now() - began).toBeLessThan(1000);
    expect(r.fake.requests[0]!.body.messages[0].content).not.toContain('Project instructions');
  });
});

describe('AGENTS.md read at the byte bound', () => {
  const K60 = 'sk-fill-' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'.repeat(2).slice(0, 52); // 60 characters
  const red = async () => {
    const r = await make();
    setKey(r.host.home, 'q', K60);
    return { r, opts: { cwd, home: r.host.home, platform: process.platform, redact: r.host.redact!, redactAll: r.host.redactAll! } };
  };

  it('a key that straddles the byte bound is not left in part, even when redaction makes the text short', async () => {
    const { opts } = await red();
    expect(K60).toHaveLength(60);
    // 61 bytes a line; byte 80,000 falls 29 characters into a key. Redacted, the 80,000 bytes come to about 15,800 characters: under the cut.
    put(cwd, 'AGENTS.md', `${K60}\n`.repeat(1640));
    const out = readAgents(opts)!;
    expect(out).not.toContain('sk-fill-');
    expect(out.endsWith(AGENTS_CUT)).toBe(true);
    expect(out.length).toBeLessThan(AGENTS_MAX);
  });

  it('an incomplete character at the bound is dropped', async () => {
    const { opts } = await red();
    put(cwd, 'AGENTS.md', 'a' + '\u{1F600}'.repeat(30_000));
    const out = readAgents(opts)!;
    expect(out).not.toContain('\ufffd');
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out)).toBe(false);
    expect(out.endsWith(AGENTS_CUT)).toBe(true);
  });

  it('a 5 MB file is read up to the bound and no further', async () => {
    const { opts } = await red();
    put(cwd, 'AGENTS.md', 'q'.repeat(5 * 1024 * 1024));
    const wanted: number[] = [];
    const real = fs.readSync;
    vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, buf: Buffer, off: number, len: number, ...rest: unknown[]) => {
      wanted.push(len);
      return (real as (...a: unknown[]) => unknown)(fd, buf, off, len, ...rest);
    }) as unknown as typeof fs.readSync);
    const out = readAgents(opts)!;
    expect(out.endsWith(AGENTS_CUT)).toBe(true);
    expect(wanted.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(80_001);
  });
});

describe('the prompt an engine sends names no provider', () => {
  it('the request body holds neither the label of the manifest nor the name of any installed provider', async () => {
    const r = await make('openai-chat', { manifest: { label: 'Zorbix Cloud', defaultModel: 'zorbix-one', models: [{ id: 'zorbix-one', context: 1000, maxOutput: 100, price: PRICE }] } });
    put(cwd, 'AGENTS.md', 'Use tabs.\n');
    r.push({ text: 'hi' });
    await (await start(r)).turn('go');
    const system: string = r.fake.requests[0]!.body.messages[0].content;
    const installed = r.mods.registry.list<{ id?: string; label?: string }>('provider').flatMap((p) => [p.id, p.label]);
    const names = [...installed, 'zorbix', 'anthropic', 'openai', 'claude', 'deepseek', 'gemini'].filter((n): n is string => !!n && n.length >= 3);
    expect(system).toContain('Use tabs.');
    for (const n of names) expect(system.toLowerCase(), n).not.toContain(n.toLowerCase());
  });
});

describe.each(WIRES)('cards: a faulty host and many cards, on %s', (wireId) => {
  const MISSING = 'no-such-file.txt';
  const read = (id: string) => call(id, 'Read', { file_path: MISSING });
  const textsAfterTools = (body: any): string[] => {
    const msgs = body.messages as any[];
    const i = msgs.map((m) => m.role).lastIndexOf('assistant');
    return msgs.slice(i + 1).flatMap((m) => (Array.isArray(m.content) ? m.content.map((b: any) => (b.type === 'text' ? b.text : '')) : m.role === 'user' ? [m.content] : [])).filter((x) => x.includes('REINS CARD'));
  };
  const cardsOf = async (pendingCards: () => unknown, n = 1) => {
    const r = await make(wireId);
    r.push(calls(read('a')), { text: 'done' });
    const res = await (await start(r, { onApprove: ALLOW, pendingCards: pendingCards as () => string[] })).turn('go');
    return { r, res, n };
  };

  it.each([
    ['throws', (): unknown => { throw new Error('queue broke'); }, 'pass', 0],
    ['answers a non-list', (): unknown => 'not a list', 'pass', 0],
    ['answers a list with items that are not texts', (): unknown => ['kept', 5, null, { x: 1 }], 'card', 1],
  ] as const)('pendingCards %s: the results stay in the history, the next request is paired, only valid texts are delivered', async (_n, pending, decision, delivered) => {
    const { r, res } = await cardsOf(pending as () => unknown);
    expect(res.text).toBe('done');
    expect(toolResults(r.fake.requests[1]!.body)).toEqual([{ id: 'a', content: `File not found: ${MISSING}` }]);
    expect(res.events).not.toContainEqual({ type: 'tool_result', tool: 'Read', output: INTERRUPTED });
    expect(ofType(res.events!, 'hook').filter((e) => e.event === 'post-tool').map((e) => e.decision)).toEqual([decision]);
    expect(ofType(res.events!, 'card_delivered')).toHaveLength(delivered);
    expect(textsAfterTools(r.fake.requests[1]!.body)).toHaveLength(delivered);
  });

  it.each([25, 50])('%i short cards in one round each arrive with their full text', async (n) => {
    const queue = Array.from({ length: n }, (_, i) => `card number ${i}`);
    const { r, res } = await cardsOf(() => queue.splice(0));
    const sent = textsAfterTools(r.fake.requests[1]!.body).join('\n');
    for (let i = 0; i < n; i++) expect(sent).toContain(`card number ${i}\n`);
    expect(sent).not.toContain('[…cut]');
    expect(ofType(res.events!, 'card_delivered')).toHaveLength(n);
  });

  it('a card over the budget is cut to it, and a cut through an emoji leaves no half of one', async () => {
    const queue = ['a' + '\u{1F600}'.repeat(6000)];
    const { r } = await cardsOf(() => queue.splice(0));
    const sent = textsAfterTools(r.fake.requests[1]!.body).join('\n');
    expect(sent).toContain(' […cut]');
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(sent)).toBe(false);
    expect(sent.length).toBeLessThan(9600 + 800);
  });
});