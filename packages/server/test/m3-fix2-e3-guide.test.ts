// M3 fix round 2, group E3: what the guides now say is run here. The money words (a track a fork branch starts spends from the branch's share; an own playbook with no
// `usd:` is capped at what is left, not uncapped), the view keys `stops` and `coreRows` (who may say them, what a copy may say), and the places the guides name them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Run } from '@reins/core';
import { m2harness } from '../../core/test/m2-harness.js';
import { startMods } from '../src/engines.js';
import { loadMods } from '../src/mods/loader.js';
import type { Mods } from '../src/mods/types.js';
import { loadWorkflowText } from '../src/run-cli.js';
import { tempHome } from './mods-harness.js';

const SRC = path.join(__dirname, '..', 'src', 'mods');
const read = (p: string) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const PACK = read(path.join(SRC, 'PACK.md'));
const MODS_README = read(path.join(SRC, 'README.md'));
const NODES_README = read(path.join(__dirname, '..', '..', 'core', 'src', 'nodes', 'README.md'));
const CHANGELOG = read(path.join(__dirname, '..', '..', '..', 'CHANGELOG.md'));
const manifestOf = (id: string): Record<string, any> => JSON.parse(read(path.join(SRC, id, 'mod.json')));

describe('the view keys stops and coreRows', () => {
  it('the guide quotes the key of the shipped subagent block, and the end block has stops', () => {
    const shown = /```\n"coreRows": (\[[^\]]*\])\n```/.exec(PACK);
    expect(shown, 'PACK.md shows the coreRows line').not.toBeNull();
    expect(JSON.parse(shown![1]!)).toEqual(manifestOf('subagent').view.coreRows);
    expect(manifestOf('end').view.stops).toBe(true);
    expect(PACK).toContain('`end` has it');
  });

  it('the nodes README lists coreRows beside stops, and says who may use it', () => {
    const list = NODES_README.split('\n').find((l) => l.startsWith('- `kind`, `order`, `colour`'))!;
    expect(list).toContain('`stops`');
    const line = NODES_README.split('\n').find((l) => l.startsWith('- `coreRows`'))!;
    expect(line).toMatch(/Only a block of the default pack/);
    expect(line).toMatch(/Customize copy/);
    expect(line).toContain('"coreRows": ["subagent_started", "subagent_result"]');
    expect(MODS_README).toMatch(/`stops` and `coreRows`[^.]*only as far as the built-in's view does/);
  });

  describe('what the guides say a copy may do is what the loader does', () => {
    let h: ReturnType<typeof tempHome>;
    let bundled: string;
    let mods: Mods | undefined;
    beforeEach(() => {
      h = tempHome();
      bundled = path.join(h.home, 'bundled');
      for (const id of ['say', 'end', 'subagent']) fs.cpSync(path.join(SRC, id), path.join(bundled, id), { recursive: true });
    });
    afterEach(() => { mods?.dispose(); mods = undefined; h.cleanup(); });
    const load = async () => (mods = await loadMods({ bundledDir: bundled, userDir: h.modsDir, home: h.home, disabled: new Set(), env: {}, trusted: () => true }));
    const copy = (id: string, edit: (m: Record<string, any>) => void = () => {}) => {
      const m = manifestOf(id);
      delete m.pack;
      delete m.required;
      edit(m);
      const code: Record<string, string> = m.main === undefined ? {} : { 'index.js': `export default function activate(api) { api.registerBlock({ kind: ${JSON.stringify(m.provides.kinds[0])}, attrs: ${JSON.stringify(m.provides.attrs ?? [])}, compile() {}, ops: {} }); }\n` };
      h.writeMod(id, m, code);
    };
    const mine = (id: string, view: Record<string, unknown>) => h.writeMod(id, { reins: 1, id, kind: 'block', version: '1.0.0', label: 'Mine', order: 30, turn: 'x', provides: { kinds: [id] }, view: { kind: id, fields: [], line: [id], ...view } });
    const problems = (m: Mods, id: string) => (m.mods.find((x) => x.id === id && x.source === 'user') ?? m.mods.find((x) => x.id === id))!.problems.join(' ');

    it('a copy of subagent with the same events, and a copy of end with stops, load', async () => {
      copy('subagent');
      copy('end');
      const m = await load();
      expect(problems(m, 'subagent')).toBe('');
      expect(problems(m, 'end')).toBe('');
    });
    it('a copy with fewer events, or without stops, loads too (the guide says "or fewer")', async () => {
      copy('subagent', (m) => { m.view.coreRows = ['subagent_result']; delete m.view.rows.subagent_started; });
      copy('end', (m) => { delete m.view.stops; });
      const m = await load();
      expect(problems(m, 'subagent')).toBe('');
      expect(problems(m, 'end')).toBe('');
    });
    it('a copy with one more event, or with stops the built-in lacks, is refused with the words the guide quotes', async () => {
      copy('subagent', (m) => { m.view.coreRows = [...m.view.coreRows, 'refusal']; m.view.rows.refusal = { text: 'x' }; });
      copy('say', (m) => { m.view.stops = true; });
      const m = await load();
      expect(problems(m, 'subagent')).toContain('a copy may say only what the built-in says');
      expect(problems(m, 'say')).toContain('a copy may say only what the built-in says');
      expect(PACK).toContain('a copy may say only what the built-in says');
    });
    it('a mod with an id of its own that has either key is refused, and so is a row of a core event without coreRows', async () => {
      mine('mine1', { stops: true });
      mine('mine2', { coreRows: ['refusal'], rows: { refusal: { text: 'x' } } });
      mine('mine3', { rows: { refusal: { text: 'x' } } });
      const m = await load();
      expect(problems(m, 'mine1')).toMatch(/stops/);
      expect(problems(m, 'mine2')).toMatch(/coreRows/);
      expect(problems(m, 'mine3')).toMatch(/event core logs/);
    });
  });
});

describe('Customize: a copy runs as the built-in does', () => {
  it('the minutes the guide names are the constants of the source', () => {
    const grace = Number(/BUILTIN_GRACE_MS = (\d+) \* 60_000/.exec(read(path.join(__dirname, '..', '..', 'core', 'src', 'run.ts')))![1]);
    const command = Number(/o\.timeoutMs \?\? (\d+) \* 60_000/.exec(read(path.join(__dirname, '..', 'src', 'commands.ts')))![1]);
    const customize = PACK.slice(PACK.indexOf('### Customize'), PACK.indexOf('### "The built-in is newer"'));
    expect(customize).toContain(`cut after ${command} minutes`);
    expect(customize).toContain(`give up on it after ${grace} minutes`);
    const wait = Number(/WORKER_WAIT_MS = (\d+) \* 60_000/.exec(read(path.join(__dirname, '..', 'src', 'session.ts')))![1]);
    expect(customize).toContain(`stops waiting for it after ${wait} minutes`);
    expect(customize).toMatch(/A copy runs the way the built-in runs/);
  });
});

describe('the guard list the nodes README points at', () => {
  it('names the allow file, and the file exists with a reason for every word', () => {
    expect(NODES_README).toContain('packages/core/test/no-kind-branch.allow.json');
    expect(NODES_README).toMatch(/exact text of each allowed line/);
    const allow = JSON.parse(read(path.join(__dirname, '..', '..', 'core', 'test', 'no-kind-branch.allow.json'))) as Record<string, { reason: string; files: Record<string, string[]> }>;
    expect(Object.keys(allow).length).toBeGreaterThan(10);
    for (const [word, a] of Object.entries(allow)) {
      expect(a.reason.length, word).toBeGreaterThan(20);
      for (const lines of Object.values(a.files)) for (const l of lines) expect(typeof l, word).toBe('string');
    }
  });
});

describe('the money words of the guides', () => {
  const head = (usd?: number) => `---\nreins: 1\nname: guide\nbudget: { turns: 40, minutes: 40${usd === undefined ? '' : `, usd: ${usd.toFixed(2)}`} }\nalways: []\n---\n\n`;
  const REVIEW = `---\nreins: 1\nname: review\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n## phase Look\n> Review {{area}}.\n`;
  const drive = async (run: Run) => { for (let k = 0; k < 80 && run.status === 'running'; k++) await run.step(); };
  const worlds: Array<{ dispose: () => void; cleanup: () => void }> = [];
  afterEach(() => { for (const w of worlds.splice(0)) { w.dispose(); w.cleanup(); } });
  /** Runs a workflow of the given body (a playbook file `review` in blocks/) and returns what each subagent session was opened with. */
  async function opens(name: string, body: string, usd?: number) {
    const t = tempHome();
    const mods = await startMods({ dir: t.home, env: {} });
    worlds.push({ dispose: () => mods.dispose(), cleanup: t.cleanup });
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-e3-pb-')));
    try {
      fs.mkdirSync(path.join(dir, 'blocks'));
      fs.writeFileSync(path.join(dir, 'blocks', 'review.reins.md'), REVIEW);
      const loaded = loadWorkflowText(`${head(usd)}${body}\n`, path.join(dir, 'ship.reins.md'));
      expect(loaded.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)).toEqual([]);
      const h = m2harness(name);
      const run = new Run({ workflow: loaded.workflow!, engine: h.engine, openSubagent: h.openSubagent, now: h.now, resolveBlock: loaded.resolveBlock });
      await drive(run);
      expect(run.status).toBe('done');
      await run.close();
      return h.subagentOpens.map((o) => [o.step, o.maxUsd] as const);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const OWN = (id: string, extra = '') => `## playbook review\nid: ${id}\ninput: area = x\nsession: own\n${extra}\n## end\n\n`;
  const FORK = (...ids: string[]) => `## fork\n${ids.map((i) => `next: ${i}`).join('\n')}\n\n## phase after\n> after\n\n## end\n\n`;

  it('an own playbook with no usd: is capped at what is left of the workflow budget, and has no cap when there is no budget anywhere', async () => {
    const body = '## playbook review\nid: pb\ninput: area = x\nsession: own';
    expect((await opens('E3a', body, 2)).map(([, cap]) => cap)).toEqual([2]);
    expect((await opens('E3b', body)).map(([, cap]) => cap)).toEqual([undefined]);
    expect((await opens('E3c', `${body}\nusd: 0.5`, 2)).map(([, cap]) => cap)).toEqual([0.5]);
  });

  it('inside a fork branch the same playbook is capped at what the branch share has left, with or without usd:', async () => {
    const two = (a: string, b: string) => opens('E3d', FORK('p1', 'p2') + OWN('p1', a) + OWN('p2', b), 2);
    const caps = (r: Array<readonly [string, number | undefined]>) => Object.fromEntries(r.filter(([s]) => s.endsWith('#own')).map(([s, c]) => [s, c]));
    expect(caps(await two('', ''))).toEqual({ 'p1#own': 1, 'p2#own': 1 });
    expect(caps(await two('usd: 0.5\n', 'usd: 1.5\n'))).toEqual({ 'p1#own': 0.5, 'p2#own': 1 });
  });

  it('PACK.md and the CHANGELOG say so', () => {
    const fork = PACK.slice(PACK.indexOf('## The fork block'));
    expect(fork).toMatch(/A track a branch starts, such as an own playbook, spends from that branch's share/);
    expect(fork).toMatch(/with no `usd:` it is capped at what the branch's share has left/);
    const usd = PACK.split('\n').find((l) => l.startsWith('| `usd:` |'))!;
    expect(usd).toMatch(/without it the playbook is capped at what is left of the budget of the playbook that uses it/i);
    expect(usd).not.toMatch(/no budget of its own\./);
    expect(CHANGELOG).toMatch(/spends from that branch's share/);
  });
});
