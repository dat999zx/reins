// M2 Task 16c: a block, condition or card mod is third-party code inside a run. Every hook of a hostile mod, made at run time in a temp home through
// the real loader (`tempHome`), must leave saving, printing, parsing, validating, Stop and the program intact. The core half is core/test/mod-contain.test.ts.
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONDS, FakeEngine, NODES, Run, compileProgram, opOf, parseWorkflow, printWorkflow, validate } from '@reins/core';
import { driveRun, type DriveIo } from '../src/drive.js';
import { loadMods } from '../src/mods/loader.js';
import type { LoadedMod, Mods } from '../src/mods/types.js';
import { startRunCli } from '../src/run-cli.js';
import { openStore } from '../src/store.js';
import { claudeEngine } from '../src/mods/claude-code-cli/engine.js';
import { commandsOf, hashCommands } from '../src/trust.js';
import { FAKE_CLAUDE, fakeSetup } from './helpers.js';
import { tempHome } from './mods-harness.js';
import { usePack } from './pack-helper.js';

const g = globalThis as unknown as Record<string, any>;
const GLOBALS = ['__started', '__gate', '__out'];
let h: ReturnType<typeof tempHome>;
const loaded: Mods[] = [];
beforeEach(() => { h = tempHome(); });
afterEach(() => {
  for (const m of loaded.splice(0).reverse()) m.dispose();
  for (const k of GLOBALS) delete g[k];
  h.cleanup();
});

const load = async () => {
  const m = await loadMods({ bundledDir: path.join(h.home, 'no-bundled'), userDir: h.modsDir, home: h.home, disabled: new Set(), trusted: () => true, env: {} });
  loaded.push(m);
  return m;
};
const find = (m: Mods, id: string) => m.mods.find((x) => x.id === id) as LoadedMod;
const coreNow = () => JSON.stringify({ n: [...NODES.keys()], c: [...CONDS.keys()], hostile: opOf('HOSTILE') !== undefined });

const manifest = (over: Record<string, unknown> = {}, provides: Record<string, unknown> = {}) => ({
  reins: 1, id: 'hostile', kind: 'block', version: '1.0.0', label: 'Hostile', main: 'index.js', order: 150,
  provides: { kinds: ['hostile'], ops: ['HOSTILE'], attrs: [], events: ['hostile_ev'], ...provides },
  view: { kind: 'hostile', fields: [], line: ['hostile'] },
  ...over,
});
interface Parts { heading?: string; validate?: string; compile?: string; exec?: string; opExtra?: string; extra?: string }
const node = (o: Parts = {}) =>
  `{ kind: 'hostile', attrs: [], ${o.heading ? `heading: ${o.heading},` : ''} ${o.validate ? `validate: ${o.validate},` : ''} compile: ${o.compile ?? "(step, ctx) => { ctx.push({ op: 'HOSTILE', step: step.id }); }"}, ops: { HOSTILE: { ${o.opExtra ?? ''} exec: ${o.exec ?? 'async (i, vm) => { vm.next(); }'} } }${o.extra ? `, ${o.extra}` : ''} }`;
const install = (n: string, provides: Record<string, unknown> = {}) =>
  h.writeMod('hostile', manifest({}, provides), { 'index.js': `export default function activate(api) { api.registerBlock(${n}); }\n` });

const head = '---\nreins: 1\nname: t\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n';
const flow = (body = '## hostile\n') => parseWorkflow(head + body).workflow!;
const errors = (body = '## hostile\n') => validate(flow(body)).filter((d) => d.severity === 'error').map((d) => d.message);
const tick = () => new Promise<void>((r) => setImmediate(r));
const io = (): DriveIo => ({ ask: async () => null, say: () => {}, write: () => {} });

async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${what}: still pending after ${ms} ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}
const runs: Run[] = [];
afterEach(async () => { for (const r of runs.splice(0)) await within(r.close(), 2000, 'close'); });
const make = (body = '## hostile\n', commandRunner?: (c: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>) => {
  const run = new Run({ workflow: flow(body), engine: new FakeEngine(), ...(commandRunner ? { commandRunner } : {}) });
  runs.push(run);
  return run;
};
const signal = () => { let fire!: () => void; const up = new Promise<void>((r) => { fire = r; }); g.__started = fire; return up; };

describe('the loader marks the node and core stores it guarded', () => {
  it('the stored node carries the loader\'s mark: the mod id and exactly provides.events', async () => {
    install(node());
    const mods = await load();
    expect(find(mods, 'hostile').problems).toEqual([]);
    expect(NODES.get('hostile')!.mod).toEqual({ id: 'hostile', events: ['hostile_ev'] });
    expect(Object.isFrozen(NODES.get('hostile'))).toBe(true);
  });

  it('a node that claims a mark of its own gets the loader\'s, and an event its mod did not declare is still refused', async () => {
    g.__out = [];
    install(node({
      exec: "async (i, vm) => { try { vm.log('other_event', {}); globalThis.__out.push('logged'); } catch (e) { globalThis.__out.push(e.message); } vm.next(); }",
      extra: "mod: { id: 'core', events: ['other_event', 'run_finished'] }",
    }));
    await load();
    expect(NODES.get('hostile')!.mod).toEqual({ id: 'hostile', events: ['hostile_ev'] });
    const run = make();
    while (run.status === 'running') await run.step();
    expect(g.__out).toHaveLength(1);
    expect(g.__out[0]).toContain('may not log "other_event"');
    expect(run.getEvents().some((e) => e.type === ('other_event' as never))).toBe(false);
  });

  it('a getter that changes `ops` after the check has no effect on what core runs', async () => {
    g.__out = [];
    h.writeMod('hostile', manifest(), {
      'index.js': `let n = 0;\nexport default function activate(api) { api.registerBlock({ kind: 'hostile', attrs: [], compile(step, ctx) { ctx.push({ op: 'HOSTILE', step: step.id }); }, get ops() { return n++ === 0 ? { HOSTILE: { async exec(i, vm) { globalThis.__out.push('good'); vm.next(); } } } : { EVIL: { async exec() { globalThis.__out.push('evil'); } } }; } }); }\n`,
    });
    await load();
    expect(opOf('EVIL')).toBeUndefined();
    expect(Object.keys(NODES.get('hostile')!.ops!)).toEqual(['HOSTILE']);
    const run = make();
    while (run.status === 'running') await run.step();
    expect(run.status).toBe('done');
    expect(g.__out).toEqual(['good']);
  });

  it('a throwing getter on the node (a heading reader) refuses the registration and leaves nothing', async () => {
    const before = coreNow();
    install("{ kind: 'hostile', attrs: [], compile() {}, get heading() { throw new Error('boom'); } }");
    const mods = await load();
    expect(find(mods, 'hostile').problems.join(' ')).toContain('boom');
    expect(coreNow()).toBe(before);
    expect(mods.registry.has('block', 'hostile')).toBe(false);
  });
});

describe('a throwing hook never breaks saving, printing, parsing or validating', () => {
  it('heading.print throwing: the workflow still saves', async () => {
    install(node({ heading: "{ parse: () => false, print() { throw new Error('boom'); } }" }));
    await load();
    const w = flow();
    expect(printWorkflow(w)).toBe(`${head}## hostile\n`);
  });

  it('heading.parse throwing: an error diagnostic', async () => {
    install(node({ heading: "{ parse() { throw new Error('boom'); }, print: () => ({ text: 'hostile', condInHeading: false }) }" }));
    await load();
    const r = parseWorkflow(`${head}## hostile arg\n`);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ severity: 'error' });
    expect(r.diagnostics[0]!.message).toContain('boom');
  });

  it('validate throwing: an error diagnostic', async () => {
    install(node({ validate: "{ early() { throw new Error('boom'); } }" }));
    await load();
    expect(errors().join(' ')).toContain('boom');
  });

  it('compile throwing: the program cannot be built, in words, and a Run does not start', async () => {
    install(node({ compile: "() => { throw new Error('boom'); }" }));
    await load();
    expect(() => compileProgram(flow())).not.toThrow();
    expect(errors().join(' ')).toContain('could not be compiled: boom');
    expect(() => new Run({ workflow: flow(), engine: new FakeEngine() })).toThrow('could not be compiled: boom');
  });
});

describe('the trust list', () => {
  usePack(); // M3 Task 4: the gate these workflows use is the default pack's
  const none = () => undefined;

  it('ops.commands throwing: a problem line in the list, so the workflow cannot run until the user sees it', async () => {
    install(node({ opExtra: "commands() { throw new Error('boom'); }," }));
    await load();
    const w = flow('## hostile\n');
    const list = commandsOf(w, none);
    expect(list.filter((l) => l.startsWith('! '))).toEqual(['! block hostile, the commands of HOSTILE: boom']);
    expect(list.at(-1)).toBe('npm test');
    // a hash of the list with the problem is not the hash of the list without it
    expect(hashCommands(list)).not.toBe(hashCommands(commandsOf(flow('## phase p\n> go\n'), none)));
  });

  it('ops.commands listing a command: it is in the trust list', async () => {
    install(node({ opExtra: "commands: () => ['echo hi']," }));
    await load();
    expect(commandsOf(flow(), none)).toEqual(['echo hi', 'npm test']);
  });

  const cond = (extra: string) => `{ t: 'ping', parse(s) { if (!s.src.startsWith('ping', s.idx)) return null; s.idx += 4; return { t: 'ping' }; }, print: () => 'ping', judge: 'agent', evalSync: () => true, ${extra} }`;
  const installCond = (extra: string) => h.writeMod('ping', { reins: 1, id: 'ping', kind: 'condition', version: '1.0.0', label: 'Ping', main: 'index.js', order: 25, provides: { conditions: ['ping'] } }, { 'index.js': `export default function activate(api) { api.registerCondition(${cond(extra)}); }\n` });

  it('a condition\'s commands appear in commandsOf', async () => {
    installCond("commands: () => ['echo pinged']");
    await load();
    const w = flow('## gate\nuntil: ping\n');
    expect(w.steps[0]!.cond).toEqual({ t: 'ping' });
    expect(commandsOf(w, none)).toEqual(['echo pinged', 'npm test']);
  });

  it('a condition\'s commands throwing: a problem line, not an exception', async () => {
    installCond("commands() { throw new Error('boom'); }");
    await load();
    const list = commandsOf(flow('## gate\nuntil: ping\n'), none);
    expect(list).toEqual(['! condition ping, its commands: boom', 'npm test']);
  });

  it('a condition that lists nothing adds nothing', async () => {
    installCond('');
    await load();
    expect(commandsOf(flow('## gate\nuntil: ping\n'), none)).toEqual(['npm test']);
  });
});

describe('Stop and the late write', () => {
  it('an exec that never settles does not hold Stop: driveRun returns within 2 s', async () => {
    install(node({ exec: 'async () => { globalThis.__started(); await new Promise(() => {}); }' }));
    await load();
    const up = signal();
    const run = make();
    const driving = driveRun(run, io(), () => {});
    await up;
    await run.stop();
    const r = await within(driving, 2000, 'driveRun');
    expect(r.result).toBe('finished');
    expect(run.status).toBe('stopped');
  });

  it('the late write of an exec that settles after Stop is dropped', async () => {
    g.__out = [];
    let release!: () => void;
    g.__gate = new Promise<void>((r) => { release = r; });
    const ran: string[] = [];
    install(node({
      opExtra: "commands: () => ['echo hi'],",
      exec: "async (i, vm) => { globalThis.__started(); await globalThis.__gate; for (const f of [() => vm.log('hostile_ev', {}), () => vm.next(), () => vm.command('echo hi')]) { try { await f(); globalThis.__out.push('written'); } catch (e) { globalThis.__out.push(e.message); } } }",
    }));
    await load();
    const up = signal();
    const run = make('## hostile\n', async (c) => { ran.push(c); return { exitCode: 0, stdout: '', stderr: '' }; });
    const driving = driveRun(run, io(), () => {});
    await up;
    await run.stop();
    await within(driving, 2000, 'driveRun');
    const types = run.getEvents().map((e) => e.type);
    release();
    await tick(); await tick();
    expect(g.__out).toHaveLength(3);
    for (const l of g.__out) expect(l).toContain('this instruction is over');
    expect(ran).toEqual([]);
    expect(run.getEvents().map((e) => e.type)).toEqual(types);
    expect(run.snapshot().programCounter).toBe(0);
  });
});

describe('the program check and goto', () => {
  for (const [label, target] of [['NaN', 'NaN'], ['-1', '-1'], ['1.5', '1.5'], ['past the end', '99']] as const) {
    it(`a JUMP to ${label} from a mod fails the check: the workflow is refused and the run does not start`, async () => {
      install(node({ compile: `(step, ctx) => { ctx.push({ op: 'JUMP', target: ${target}, step: step.id }); }` }));
      await load();
      expect(errors().join(' ')).toContain('which is not a place in the program');
      expect(() => new Run({ workflow: flow(), engine: new FakeEngine() })).toThrow('which is not a place in the program');
    });
  }

  it('goto(99) from a mod op pauses the track with words; it does not crash and the counter does not move', async () => {
    install(node({ exec: 'async (i, vm) => { vm.goto(99); }' }));
    await load();
    const run = make();
    expect(await run.step()).toBe('paused');
    expect(run.pauseReason).toMatchObject({ type: 'stop' });
    expect(run.pauseReason!.text).toContain('99, which is not a place in the program');
    expect(run.snapshot().programCounter).toBe(0);
  });
});

describe('what a mod op may run and log', () => {
  it('vm.command(\'rm x\') is refused unless the op lists it; a listed command runs', async () => {
    g.__out = [];
    install(node({
      opExtra: "commands: () => ['echo hi'],",
      exec: "async (i, vm) => { for (const c of ['rm x', 'echo hi']) { try { await vm.command(c); globalThis.__out.push('ran ' + c); } catch (e) { globalThis.__out.push(e.message); } } vm.next(); }",
    }));
    await load();
    const ran: string[] = [];
    const run = make('## hostile\n', async (c) => { ran.push(c); return { exitCode: 0, stdout: '', stderr: '' }; });
    while (run.status === 'running') await run.step();
    expect(ran).toEqual(['echo hi']);
    expect(g.__out[0]).toContain('may not run "rm x"');
    expect(g.__out[1]).toBe('ran echo hi');
  });

  it('vm.log(\'other_event\') is refused unless provides.events lists it; a listed event is logged', async () => {
    g.__out = [];
    install(node({ exec: "async (i, vm) => { try { vm.log('other_event', {}); globalThis.__out.push('logged'); } catch (e) { globalThis.__out.push(e.message); } vm.log('hostile_ev', { ok: 1 }); vm.next(); }" }));
    await load();
    const run = make();
    while (run.status === 'running') await run.step();
    expect(g.__out).toHaveLength(1);
    expect(g.__out[0]).toContain('provides.events does not list it');
    expect(run.getEvents().filter((e) => e.type === ('hostile_ev' as never)).map((e) => e.data)).toEqual([{ ok: 1 }]);
    expect(run.getEvents().some((e) => e.type === ('other_event' as never))).toBe(false);
  });

  it('a rejection from a vm member keeps today\'s path: driveRun reports it as the run\'s error; a mod\'s own throw pauses instead', async () => {
    install(node({ opExtra: "commands: () => ['echo hi'],", exec: "async (i, vm) => { await vm.command('echo hi'); vm.next(); }" }));
    await load();
    const run = make('## hostile\n', async () => { throw new Error('runner down'); });
    const r = await within(driveRun(run, io(), () => {}), 2000, 'driveRun');
    expect(r).toEqual({ result: 'detached', error: 'runner down' });

    for (const m of loaded.splice(0)) m.dispose();
    install(node({ exec: "async () => { throw new Error('mine'); }" }));
    await load();
    const own = make();
    expect(await own.step()).toBe('paused');
    expect(own.pauseReason!.text).toContain('mine');
  });
});

describe('what a mod prints in `reins run` is one visible, capped line', () => {
  it('a control character is shown, a huge line is cut', async () => {
    install(
      node({
        exec: "async (i, vm) => { vm.log('hostile_ev', {}); vm.next(); }",
        extra: "print: { hostile_ev: () => String.fromCharCode(27) + '[2J' + String.fromCharCode(8238) + 'x'.repeat(5000) }",
      }),
    );
    await load();
    const f = fakeSetup([]);
    const file = path.join(f.dir, 'w.reins.md');
    fs.writeFileSync(file, head + '## hostile\n');
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.setEncoding('utf8');
    output.on('data', (d: string) => { out += d; });
    const store = openStore(':memory:');
    const res = await startRunCli({
      file, cwd: f.dir, input, output, store,
      makeEngine: ({ onApprove, onLive }) => claudeEngine({ bin: FAKE_CLAUDE, onApprove, onLive }),
    }).done;
    expect(res.status).toBe('done');
    expect(out).not.toContain(String.fromCharCode(27));
    expect(out).not.toContain(String.fromCharCode(8238));
    const line = out.split('\n').find((l) => l.includes('<U+001B>'))!;
    expect(line).toContain('<U+001B>[2J<U+202E>xxx');
    expect(line.length).toBeLessThan(400);
    store.close();
  }, 60_000);
});
