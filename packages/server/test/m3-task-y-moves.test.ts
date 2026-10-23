// M3 group Y: `run`, `repeat` and `verify` are bundled pack mods. The pack's own code runs as core's ops did (m3-task-y-pin.test.ts pins that against HEAD). A Customize
// copy of one is an ORDINARY mod: its ops are fenced (they log, run commands and judge only what the fence allows) and raced with Stop. These tests make the copies of all
// three through the import path, restart, and run the same workflows with the same scripts: the events, the commands, the pauses and the receipt must be the pin's.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { NODES, modOfOp, opOf } from '@reins/core';
import { startMods } from '../src/engines.js';
import { customizeMod, type ModEnv } from '../src/mods/actions.js';
import type { Mods } from '../src/mods/types.js';
import { WF, drive, stopDuring, type Opts } from './m3-task-y-drive.js';

const MODS_DIR = path.resolve(import.meta.dirname, '../src/mods');
const PIN = JSON.parse(fs.readFileSync(new URL('./m3-task-y-pin.expected.json', import.meta.url), 'utf8')) as { runs: Record<string, unknown>; stops: Record<string, unknown> };
// What the pin's workflows use: these blocks and these condition atoms. The pack mods are picked by what their manifest provides, not by folder name.
const NEED = { kinds: ['phase', 'say', 'end', 'run', 'repeat', 'verify'], conditions: ['tests', 'cmd', 'done'] };
const needed = (): string[] => fs.readdirSync(MODS_DIR, { withFileTypes: true }).filter((d) => {
  const file = path.join(MODS_DIR, d.name, 'mod.json');
  if (!d.isDirectory() || !fs.existsSync(file)) return false;
  const m = JSON.parse(fs.readFileSync(file, 'utf8')) as { pack?: string; provides?: { kinds?: string[]; conditions?: string[] } };
  return m.pack === 'default' && (NEED.kinds.some((k) => m.provides?.kinds?.includes(k)) || NEED.conditions.some((c) => m.provides?.conditions?.includes(c)));
}).map((d) => d.name);

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });
const scratch = (): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-ymoves-')));
  cleanups.push(() => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the OS */ } });
  return d;
};

/** What `tsc` makes of one pack folder: each `.ts` file compiled alone, `mod.json` copied (the same as pack-mods.test.ts). */
function build(folder: string, out: string): void {
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(folder)) {
    const text = fs.readFileSync(path.join(folder, f), 'utf8');
    if (f.endsWith('.d.ts')) continue;
    if (f.endsWith('.ts')) fs.writeFileSync(path.join(out, f.replace(/\.ts$/, '.js')), ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true } }).outputText);
    else fs.writeFileSync(path.join(out, f), text);
  }
}
const envOf = (home: string, mods: () => Mods): ModEnv => ({
  home, catalogDir: path.join(home, 'no-catalog'), get mods() { return mods(); }, consent: { has: () => false, grant: () => {}, revoke: () => {} } as never,
  send: async () => new Response(''), env: {}, redact: (t: string) => t, holdsSecret: () => false,
});

/** A home whose bundled folder holds only the pack mods the workflows use; `copied` of them are customized (copied into the home and run from the cache). */
async function world(copied: string[]): Promise<Mods> {
  const root = scratch();
  const bundled = path.join(root, 'bundled');
  for (const id of needed()) build(path.join(MODS_DIR, id), path.join(bundled, id));
  const home = path.join(root, '.reins');
  fs.mkdirSync(home, { recursive: true });
  let mods = await startMods({ dir: home, env: {}, bundledDir: bundled });
  cleanups.push(() => mods.dispose());
  for (const id of copied) {
    const r = await customizeMod(envOf(home, () => mods), id, { trust: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  mods.dispose();
  mods = await startMods({ dir: home, env: {}, bundledDir: bundled });
  cleanups.push(() => mods.dispose());
  expect(mods.problems).toEqual([]);
  return mods;
}

const SCENARIOS: Array<[string, string, Opts]> = [
  ['runFixPass', 'runFix', { cmds: [1, 0] }],
  ['runFixBudget', 'runFix', { cmds: [1], allow: 1 }],
  ['runFixHeld', 'runFix', { cmds: [1] }],
  ['runFailTarget', 'runFailTarget', { cmds: [1] }],
  ['verifyFailTarget', 'verifyFailTarget', { turns: ['plan', 'REINS: fail: x', 'fixed'] }],
  ['runOdd', 'runOdd', { cmds: [0] }],
  ['runNext', 'runNext', { cmds: [1] }],
  ['repeatTests', 'repeatTests', { cmds: [1, 1, 0] }],
  ['repeatTestsFirstPass', 'repeatTests', { cmds: [0] }],
  ['repeatLint', 'repeatLint', { cmds: [1, 0] }],
  ['repeatOther', 'repeatOther', { cmds: [0, 1, 0, 0] }],
  ['repeatOtherFailRun', 'repeatOther', { cmds: [1] }],
  ['repeatLate', 'repeatLate', { cmds: [0] }],
  ['repeatLateFail', 'repeatLate', { cmds: [1, 0] }],
  ['repeatNoCmd', 'repeatNoCmd', { cmds: [1, 0] }],
  ['repeatAgent', 'repeatAgent', { turns: ['a', 'b', 'c\nREINS: done'] }],
  ['repeatBudgetHeld', 'repeatBudget', { cmds: [1] }],
  ['repeatBudgetMore', 'repeatBudget', { cmds: [1, 1, 1, 0], allow: 2 }],
  ['repeatNested', 'repeatNested', { cmds: [1, 0, 0, 1, 0] }],
  ['repeatNot', 'repeatNot', { cmds: [0, 1] }],
  ['verifyFlow', 'verify', { turns: ['plan', 'REINS: fail: nothing', 'plan again', 'REINS: pass', 'no against', 'checked', 'later'] }],
  ['verifyBudget', 'verify', { turns: ['plan', 'REINS: fail', 'p', 'REINS: fail', 'p', 'REINS: fail', 'p', 'REINS: pass'], allow: 1 }],
  ['verifyDeep', 'verifyDeep', { turns: ['plan', 'REINS: fail: x', 'plan', 'REINS: pass', 'ok\nREINS: done'] }],
];

describe('M3 group Y: Customize copies of run, repeat and verify (ordinary, fenced mods) behave as the pack does', () => {
  it('the copies are the ordinary mods: their ops are fenced, the pack\'s own are not', async () => {
    const pack = await world([]);
    for (const k of ['run', 'repeat', 'verify']) for (const op of Object.values(NODES.get(k)!.ops!)) expect(modOfOp(op)).toMatchObject({ id: k, pack: true });
    pack.dispose();
    const copies = await world(['run', 'repeat', 'verify']);
    for (const k of ['run', 'repeat', 'verify']) for (const op of Object.values(NODES.get(k)!.ops!)) expect(modOfOp(op)?.pack).toBeUndefined();
    expect(modOfOp(opOf('RUN')!)).toMatchObject({ id: 'run' });
    copies.dispose();
  });

  it('every scenario of the pin gives the same events, commands, pauses, texts and receipt through the copies', async () => {
    const mods = await world(['run', 'repeat', 'verify']);
    try {
      const bad: string[] = [];
      for (const [name, key, opts] of SCENARIOS) {
        const got = JSON.parse(JSON.stringify(await drive(WF[key]!, opts)));
        if (JSON.stringify(got) !== JSON.stringify(PIN.runs[name])) { bad.push(name); if (process.env.DBG) fs.writeFileSync(`${process.env.DBG}/${name}.json`, JSON.stringify(got, null, 1)); }
      }
      expect(bad).toEqual([]);
    } finally {
      mods.dispose();
    }
  }, 60_000);

  it('one copy beside the pack\'s other blocks works as well: the copied run in the pack\'s repeat, the copied repeat around the pack\'s run', async () => {
    for (const copied of [['run'], ['repeat'], ['verify']]) {
      const mods = await world(copied);
      try {
        const bad: string[] = [];
        for (const [name, key, opts] of SCENARIOS) {
          const got = JSON.parse(JSON.stringify(await drive(WF[key]!, opts)));
          if (JSON.stringify(got) !== JSON.stringify(PIN.runs[name])) bad.push(`${copied[0]}: ${name}`);
        }
        expect(bad).toEqual([]);
      } finally {
        mods.dispose();
      }
    }
  }, 90_000);

  it('a copy is an ordinary mod to Stop: the run does not wait for its command (the pack\'s own code does, see the pin)', async () => {
    const mods = await world(['run']);
    try {
      const copy = await stopDuring(WF.runFix!, false);
      const own = PIN.stops.runStopThenSettle as { counter: number; events: Array<{ type: string }> };
      expect(own.events.map((e) => e.type)).toContain('command_result');   // the pack's: waited for, recorded
      expect(copy.status).toBe('stopped');
      expect(copy.events.map((e) => e.type)).not.toContain('command_result');
      expect(copy.counter).toBe(0);
    } finally {
      mods.dispose();
    }
  });
});
