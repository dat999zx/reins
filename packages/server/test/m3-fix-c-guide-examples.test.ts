// M3 fix round, group C: every example in the pack-mod guide (`packages/server/src/mods/PACK.md`) is run here. The examples are the constants below. The mods are
// installed the way a user installs them (the import path, with the trust the preview asked for), then a workflow that uses each one is parsed, printed back, validated,
// compiled and RUN. The last test checks that the guide holds every example byte for byte, so the text in the guide is the text that ran.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Run, checkTool, compileProgram, parseCond, parseWorkflow, printCond, printWorkflow, receipt, validate, type RunOptions } from '@reins/core';
import { m2harness } from '../../core/test/m2-harness.js';
import { startMods } from '../src/engines.js';
import { TRACKS_LINE, customizeMod, exportBundle, importApply, importPreview, isNewer, listMods, type ModEnv } from '../src/mods/actions.js';
import type { Mods } from '../src/mods/types.js';
import { loadWorkflowText } from '../src/run-cli.js';
import { tempHome } from './mods-harness.js';

// ---- the examples (the guide holds these exact texts) ----

export const PING_MOD = `{
  "reins": 1,
  "id": "ping",
  "kind": "block",
  "version": "1.0.0",
  "label": "Ping",
  "description": "A turn whose prompt starts with Ping:",
  "main": "index.js",
  "order": 200,
  "provides": { "kinds": ["ping"], "attrs": ["mode"] },
  "view": {
    "kind": "ping",
    "order": 200,
    "colour": "soft",
    "fields": [
      { "key": "prompt", "label": "Prompt", "input": "textarea" },
      { "key": "mode", "label": "Mode", "input": "mode", "unset": "write" }
    ],
    "line": ["ping", { "field": "prompt" }],
    "cards": true,
    "card": { "label": "ping", "section": "Flow" },
    "fresh": {}
  }
}`;
export const PING_CODE = `export default function activate(api) {
  const { checkMode, turnInstr } = api.core;
  api.registerBlock({
    kind: 'ping',
    attrs: ['mode'],
    validate: { early: checkMode },
    compile(step, ctx) {
      ctx.push(turnInstr({ ...step, prompt: \`Ping: \${step.prompt ?? ''}\` }));
    },
  });
}`;
export const PING_USE = `## ping
> look at the logs`;

export const EXISTS_MOD = `{
  "reins": 1,
  "id": "cond-exists",
  "kind": "condition",
  "version": "1.0.0",
  "label": "Condition: file exists",
  "description": "True when a file exists in the project folder",
  "main": "index.js",
  "order": 200,
  "provides": { "conditions": ["exists"] },
  "view": {
    "exists": { "label": "file exists", "fresh": { "t": "exists", "glob": "README.md" }, "param": { "key": "glob", "look": "pill" } }
  }
}`;
export const EXISTS_CODE = `import fs from 'node:fs';
import path from 'node:path';

export default function activate(api) {
  api.registerCondition({
    t: 'exists',
    parse(s) {
      if (!s.src.startsWith('exists', s.idx)) return null;
      s.idx += 'exists'.length;
      s.skipWs();
      const start = s.idx;
      while (s.idx < s.len && !/\\s|[)]/.test(s.src[s.idx])) s.idx++;
      if (start === s.idx) return s.error('Expected a file name after "exists"', start);
      return { t: 'exists', glob: s.src.slice(start, s.idx) };
    },
    print(c) { return \`exists \${c.glob}\`; },
    judge: 'deterministic',
    globs(c) { return [c.glob]; },
    evalSync(c, ctx) { return fs.existsSync(path.join(ctx.cwd, c.glob)); },
  });
}`;
export const EXISTS_USE = `## if exists ready.txt

### phase Ship it
> ship it`;

export const NOSHELL_MOD = `{
  "reins": 1,
  "id": "card-noshell",
  "kind": "card",
  "version": "1.0.0",
  "label": "Card: no shell",
  "description": "A step with this card may not run shell commands",
  "main": "index.js",
  "order": 200,
  "provides": { "cards": ["noshell"] },
  "view": {
    "noshell": { "section": "No shell", "add": "Add no-shell" }
  }
}`;
export const NOSHELL_CODE = `export default function activate(api) {
  api.registerCard({
    kind: 'noshell',
    turnLine(card) { return \`Do not run shell commands. (\${card.text})\`; },
    policy(card, policy) { policy.allowShell = false; },
  });
}`;
export const NOSHELL_USE = `## phase Read the code
noshell: this step only reads
> read the parser`;

export const FORK_FILE = `## phase Plan
> Plan the work.

## fork
next: api
next: db

## phase Build
> Build it from both results.

## end

## phase API research
id: api
mode: read-only
> Read the API docs.

## end

## phase DB research
id: db
mode: read-only
> Read the schema.

## end`;

export const SHIP_FILE = `## phase Plan
> Plan the change.

## playbook review
id: review
input: area = the API; depth = quick
session: own
usd: 0.50
output: report

## phase Wrap up
> Summarise the review.`;
export const REVIEW_FILE = `---
reins: 1
name: review
budget: { turns: 5, minutes: 5 }
always: []
---

## phase Look
> Review {{area}}, {{depth}} pass.

## phase Write
id: report
> Write the findings for {{area}}.`;
export const INLINE_FILE = `## playbook review
input: area = the parser; depth = deep`;

// ---- helpers ----

const head = (extra = '') => `---\nreins: 1\nname: guide\nbudget: { turns: 40, minutes: 40${extra} }\nalways: []\n---\n\n`;
const parse = (body: string, extra = '') => {
  const text = `${head(extra)}${body}\n`;
  const p = parseWorkflow(text);
  expect(p.diagnostics).toEqual([]);
  expect(printWorkflow(p.workflow!)).toBe(text);
  return p.workflow!;
};
const errorsOf = (w: ReturnType<typeof parse>) => validate(w).filter((d) => d.severity === 'error').map((d) => d.message);
const drive = async (run: Run) => { for (let k = 0; k < 80 && run.status === 'running'; k++) await run.step(); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean) => { for (let k = 0; k < 400 && !f(); k++) await sleep(5); expect(f()).toBe(true); };

interface World { t: ReturnType<typeof tempHome>; mods: Mods; env: ModEnv }
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) { w.mods.dispose(); w.t.cleanup(); } });
async function world(bundledDir?: string): Promise<World> {
  const t = tempHome();
  const mods = await startMods({ dir: t.home, env: {}, ...(bundledDir ? { bundledDir } : {}) });
  const w: World = {
    t, mods,
    env: { home: t.home, catalogDir: path.join(t.home, 'no-catalog'), mods, consent: { has: () => false, grant: () => {}, revoke: () => {} }, send: async () => new Response(''), env: {}, redact: (x) => x, holdsSecret: () => false },
  };
  worlds.push(w);
  return w;
}
const body = (r: { body: unknown }) => r.body as Record<string, any>;
/** Installs mods the way the import dialog does: preview, read each code mod's hash, import with that trust. Returns the reply. */
async function install(w: World, mods: Record<string, Record<string, string>>) {
  const file = { reinsMods: 1, mods };
  const p = importPreview(w.env, file);
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  const trust = Object.fromEntries((body(p).summary.mods as any[]).filter((m) => m.hasCode).map((m) => [m.id, m.hash as string]));
  const r = await importApply(w.env, { file, trust });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r;
}
const files = (manifest: string, code: string) => ({ 'mod.json': `${manifest}\n`, 'index.js': `${code}\n` });
const three = () => ({ ping: files(PING_MOD, PING_CODE), 'cond-exists': files(EXISTS_MOD, EXISTS_CODE), 'card-noshell': files(NOSHELL_MOD, NOSHELL_CODE) });

describe('guide: a block as a mod (ping)', () => {
  it('installs through the import path, parses, prints back, compiles to a TURN and runs with the prefixed prompt', async () => {
    const w = await world();
    await install(w, three());
    const mod = w.mods.mods.find((m) => m.id === 'ping')!;
    expect(mod).toMatchObject({ kind: 'block', problems: [], trusted: true, hasCode: true });
    const wf = parse(PING_USE);
    expect(wf.steps[0]).toMatchObject({ kind: 'ping', id: 'ping-1', prompt: 'look at the logs' });
    expect(errorsOf(wf)).toEqual([]);
    expect(compileProgram(wf)[0]).toMatchObject({ op: 'TURN', step: 'ping-1' });
    const h = m2harness('PING');
    const run = new Run({ workflow: wf, engine: h.engine, openSubagent: h.openSubagent, now: h.now });
    h.script('PING-main-1', { text: 'ok\nREINS: done' });
    await drive(run);
    expect(run.status).toBe('done');
    expect(h.stats('PING-main-1').texts[0]).toContain('Ping: look at the logs');
    await run.close();
  });

  it('a bad mode is the checkMode error of the mod (the guide says what api.core.checkMode does)', async () => {
    const w = await world();
    await install(w, three());
    const wf = parse('## ping\nmode: sideways\n> hi');
    expect(errorsOf(wf).join('\n')).toMatch(/mode must be read-only or write/);
  });
});

describe('guide: a condition as a mod (exists)', () => {
  it('parses, prints back, and the if block follows the file: present runs the step, absent skips it', async () => {
    const w = await world();
    await install(w, three());
    const cond = parseCond('exists ready.txt');
    expect(cond.diag).toBeUndefined();
    expect(cond.cond).toEqual({ t: 'exists', glob: 'ready.txt' });
    expect(printCond(cond.cond!)).toBe('exists ready.txt');
    expect(parseCond('exists').diag?.message).toMatch(/Expected a file name after "exists"/);
    const wf = parse(EXISTS_USE);
    expect(errorsOf(wf)).toEqual([]);
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-guide-exists-')));
    try {
      const turns = async (scn: string, present: boolean) => {
        const d = path.join(dir, scn);
        fs.mkdirSync(d);
        if (present) fs.writeFileSync(path.join(d, 'ready.txt'), 'x');
        const h = m2harness(scn);
        h.script(`${scn}-main-1`, { text: 'ok\nREINS: done' });
        const run = new Run({ workflow: wf, engine: h.engine, openSubagent: h.openSubagent, now: h.now, cwd: d });
        await drive(run);
        expect(run.status).toBe('done');
        await run.close();
        return h.stats(`${scn}-main-1`).texts.length;
      };
      expect(await turns('E1', true)).toBe(1);
      expect(await turns('E2', false)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('guide: a card as a mod (noshell)', () => {
  it('parses the card line, prints it back, puts its line in the turn and turns the shell off in the policy', async () => {
    const w = await world();
    await install(w, three());
    const wf = parse(NOSHELL_USE);
    expect(wf.steps[0]!.cards).toEqual([expect.objectContaining({ kind: 'noshell', text: 'this step only reads' })]);
    expect(errorsOf(wf)).toEqual([]);
    const turn = compileProgram(wf)[0] as { op: string; policy: { allowShell: boolean; mode: string }; src: unknown };
    expect(turn).toMatchObject({ op: 'TURN', policy: { allowShell: false, mode: 'write' } });
    const policy = turn.policy as Parameters<typeof checkTool>[0];
    expect(checkTool(policy, 'Bash', { command: 'ls' }, '.')).toBe('Blocked by Reins: shell commands are not allowed in this step.');
    expect(checkTool(policy, 'Read', { file_path: 'a.ts' }, '.')).toBeNull();
    const h = m2harness('NOSH');
    h.script('NOSH-main-1', { text: 'ok\nREINS: done' });
    const run = new Run({ workflow: wf, engine: h.engine, openSubagent: h.openSubagent, now: h.now });
    await drive(run);
    expect(h.stats('NOSH-main-1').texts[0]).toContain('Do not run shell commands. (this step only reads)');
    await run.close();
  });
});

describe('guide: the fork block', () => {
  const mk = (h: ReturnType<typeof m2harness>, extra = '', opts: Partial<RunOptions> = {}) =>
    new Run({ workflow: parse(FORK_FILE, extra), engine: h.engine, openSubagent: h.openSubagent, now: h.now, ...opts });

  it('the file has no error and no warning, compiles to one FORK, and runs: each branch gets the last reply, the block under the fork gets both results', async () => {
    const w = await world();
    expect(validate(parse(FORK_FILE))).toEqual([]);
    expect(compileProgram(parse(FORK_FILE)).filter((i) => i.op === 'FORK')).toHaveLength(1);
    const h = m2harness('FK');
    h.script('FK-main-1', { text: 'PLAN-REPLY\nREINS: done' }, { text: 'built\nREINS: done' });
    h.script('FK-sub-api', { text: 'api-says\nREINS: done' });
    h.script('FK-sub-db', { text: 'db-says\nREINS: done' });
    const run = mk(h);
    await drive(run);
    expect(run.status).toBe('done');
    expect(h.stats('FK-sub-api').texts[0]).toContain('The last reply before the fork (step plan)');
    expect(h.stats('FK-sub-api').texts[0]).toContain('PLAN-REPLY');
    expect(h.stats('FK-sub-db').texts[0]).toContain('PLAN-REPLY');
    const build = h.stats('FK-main-1').texts[1]!;
    expect(build.indexOf('Result of Branch API research (step api)')).toBeGreaterThan(-1);
    expect(build.indexOf('Result of Branch API research')).toBeLessThan(build.indexOf('Result of Branch DB research'));
    expect(build).toContain('api-says');
    expect(build).toContain('db-says');
    expect(run.getEvents().filter((e) => e.type === 'track_started').map((e) => e.data.title)).toEqual(['Branch API research', 'Branch DB research']);
    expect(receipt(run.getEvents()).counts).toMatchObject({ forks: 1 });
    await run.close();
    void w;
  });

  it('money: with a $1.00 workflow budget two branches get 0.50 each; with none, no cap', async () => {
    await world();
    const h = m2harness('FM');
    await drive(mk(h, ', usd: 1.00'));
    expect(h.subagentOpens.map((o) => [o.step, o.maxUsd])).toEqual([['api', 0.5], ['db', 0.5]]);
    const g = m2harness('FM2');
    await drive(mk(g));
    expect(g.subagentOpens.map((o) => [o.step, o.maxUsd])).toEqual([['api', undefined], ['db', undefined]]);
  });

  it('a branch that fails pauses alone on its own card; Resume goes on; Stop reaches every branch', async () => {
    await world();
    const h = m2harness('FF');
    h.script('FF-main-1', { text: 'P\nREINS: done' }, { text: 'B\nREINS: done' });
    h.script('FF-sub-api', { text: 'alpha\nREINS: done' });
    h.script('FF-sub-db', { text: 'beta\nREINS: done' });
    const hold = h.hold('FF-sub-api');
    const run = mk(h);
    const driven = drive(run);
    await hold.started;
    hold.fail(new Error('boom'));
    await until(() => run.tracks.get('api')?.state === 'paused' && run.ended.length === 1);
    expect(run.status).toBe('running');
    expect(run.pauses()).toHaveLength(1);
    expect(run.pauses()[0]).toMatchObject({ track: 'api', title: 'Branch API research', text: 'Branch API research failed: boom; Resume tries again' });
    run.resume('api');
    await driven;
    await until(() => run.status === 'done');
    await run.close();

    const s = m2harness('FS');
    const a = s.hold('FS-sub-api');
    const b = s.hold('FS-sub-db');
    const stopped = mk(s);
    const d2 = drive(stopped);
    await Promise.all([a.started, b.started]);
    await stopped.stop();
    await d2;
    await stopped.close();
    expect(stopped.status).toBe('stopped');
    expect(s.stats('FS-sub-api').closed).toBe(1);
    expect(s.stats('FS-sub-db').closed).toBe(1);
  });

  it('a gate in a branch is an approval card titled with the branch', async () => {
    await world();
    const h = m2harness('FG');
    const text = FORK_FILE.replace('## phase API research\nid: api\nmode: read-only\n> Read the API docs.\n', '## phase API research\nid: api\nmode: read-only\n> Read the API docs.\n\n## gate\nuntil: you approve\n');
    const run = new Run({ workflow: parse(text), engine: h.engine, openSubagent: h.openSubagent, now: h.now });
    const driven = drive(run);
    await until(() => run.pauses().length === 1);
    expect(run.pauses()[0]).toMatchObject({ track: 'api', title: 'Branch API research', type: 'gate' });
    run.approve('api');
    await driven;
    await run.close();
  });
});

describe('guide: the playbook block', () => {
  const setup = (blocks: Record<string, string>) => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reins-guide-pb-')));
    fs.mkdirSync(path.join(dir, 'blocks'));
    for (const [name, text] of Object.entries(blocks)) fs.writeFileSync(path.join(dir, 'blocks', `${name}.reins.md`), text);
    return { dir, file: path.join(dir, 'ship.reins.md'), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
  };
  const ship = (body: string) => `${head(', usd: 2.00')}${body}\n`;

  it('an own playbook: inputs filled in, its own session and budget, only the named output handed back', async () => {
    await world();
    const s = setup({ review: REVIEW_FILE });
    try {
      const text = ship(SHIP_FILE);
      const loaded = loadWorkflowText(text, s.file);
      expect(loaded.diagnostics).toEqual([]);
      const wf = loaded.workflow!;
      const program = compileProgram(wf, loaded.resolveBlock);
      expect(program.find((i) => i.op === 'PLAYBOOK')).toMatchObject({ session: 'own', usd: 0.5, outputs: ['report'] });
      const h = m2harness('PB');
      h.script('PB-main-1', { text: 'plan\nREINS: done' }, { text: 'wrapped\nREINS: done' });
      for (const key of ['review', 'review#own']) h.script(`PB-sub-${key}`, { text: 'looked\nREINS: done' }, { text: 'FINDINGS\nREINS: done' });   // the track key is the step id or `<id>#own`: the test does not care which
      const run = new Run({ workflow: wf, engine: h.engine, openSubagent: h.openSubagent, now: h.now, resolveBlock: loaded.resolveBlock });
      await drive(run);
      expect(run.status).toBe('done');
      const sub = `PB-sub-${h.subagentOpens[0]!.step}`;
      expect(h.stats(sub).texts[0]).toContain('Review the API, quick pass.');
      expect(h.stats(sub).texts[1]).toContain('Write the findings for the API.');
      expect(h.subagentOpens.map((o) => o.maxUsd)).toEqual([0.5]);
      const wrap = h.stats('PB-main-1').texts[1]!;
      expect(wrap).toContain('Output "report" of Playbook review (step review/report)');
      expect(wrap).toContain('FINDINGS');
      expect(wrap).not.toContain('looked');
      expect(receipt(run.getEvents()).counts).toMatchObject({ playbooks: 1 });
      await run.close();
    } finally { s.done(); }
  });

  it('an inline playbook runs in the same session; its steps are ids under the playbook step', async () => {
    await world();
    const s = setup({ review: REVIEW_FILE });
    try {
      const loaded = loadWorkflowText(ship(INLINE_FILE), s.file);
      expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      const program = compileProgram(loaded.workflow!, loaded.resolveBlock);
      expect(program.filter((i) => i.op === 'TURN').map((i) => (i as { step: string }).step)).toEqual(['playbook-1/look', 'playbook-1/report']);
    } finally { s.done(); }
  });

  it('the limits the guide lists: a path, a missing input, an unknown output, session other than own, usd without own, a file that runs itself', async () => {
    await world();
    const s = setup({ review: REVIEW_FILE, loop: `---\nreins: 1\nname: loop\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n## playbook loop\n` });
    try {
      const err = (body: string) => loadWorkflowText(ship(body), s.file).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message).join('\n');
      expect(err('## playbook ../secret')).toMatch(/Playbook "\.\.\/secret": its name must be one plain file name/);
      expect(err('## playbook nothere')).toMatch(/Playbook "nothere" not found/);
      expect(err('## playbook review\ninput: area = x')).toMatch(/gives no input `depth`/);
      expect(err('## playbook review\ninput: area = x; depth = y\nsession: own\noutput: nope')).toMatch(/`review` has no step `nope`/);
      expect(err('## playbook review\ninput: area = x; depth = y\nsession: sideways')).toMatch(/`session:` must be `own`/);
      expect(err('## playbook review\ninput: area = x; depth = y\nusd: 1')).toMatch(/`usd:` on playbook `review-1` needs `session: own`|`usd:` on playbook `[^`]*` needs `session: own`/);
      expect(err('## playbook loop')).toMatch(/runs itself/);
    } finally { s.done(); }
  });

  it('a fork inside a playbook is refused, inline or own (the guide says a fork cannot be inside any playbook)', async () => {
    await world();
    const inside = `---\nreins: 1\nname: inner\nbudget: { turns: 5, minutes: 5 }\nalways: []\n---\n\n${FORK_FILE}\n`;
    const s = setup({ inner: inside });
    try {
      const err = (use: string) => loadWorkflowText(ship(use), s.file).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message).join('\n');
      expect(err('## playbook inner')).toMatch(/fork|branches at the same time/);
      expect(err('## playbook inner\nsession: own')).toMatch(/fork|branches at the same time/);
      expect(loadWorkflowText(ship('## phase one\n> go'), s.file).diagnostics).toEqual([]);   // the bite: the same file has no error without the playbook
    } finally { s.done(); }
  });
});

describe('guide: Customize and the built-in being newer', () => {
  // The source folder holds index.ts; Customize copies the built files, so this one test starts from the built folder (and is skipped when there is none).
  const built = fileURLToPath(new URL('../dist/mods/', import.meta.url));
  it.skipIf(!fs.existsSync(path.join(built, 'say', 'index.js')))('Customize copies the pack mod without pack and required; removing the copy goes back to the built-in', async () => {
    const w = await world(built);
    const before = body(await listMods(w.env)).mods as any[];
    const say = before.find((m) => m.id === 'say');
    expect(say).toMatchObject({ bundled: true, pack: 'default' });
    const phase = before.find((m) => m.id === 'phase');
    expect(phase).toMatchObject({ required: true, pack: 'default' });
    // a required mod has no off switch
    const { setEnabled, removeMod } = await import('../src/mods/actions.js');
    expect((await setEnabled(w.env, 'phase', false)).status).toBe(409);
    expect((await setEnabled(w.env, 'say', false)).status).toBe(200);
    expect((await setEnabled(w.env, 'say', true)).status).toBe(200);
    expect((await removeMod(w.env, 'say')).status).toBe(409);
    // Customize
    const copy = await customizeMod(w.env, 'say', { trust: true });
    expect(copy.status, JSON.stringify(copy.body)).toBe(200);
    const folder = path.join(w.t.modsDir, 'say');
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'mod.json'), 'utf8'));
    expect(manifest.pack).toBeUndefined();
    expect(manifest.required).toBeUndefined();
    expect(manifest.id).toBe('say');
    expect(fs.readdirSync(folder).sort()).toEqual(['index.js', 'mod.json']);
    // a second Customize is refused: your copy is never replaced
    expect((await customizeMod(w.env, 'say', { trust: true })).status).toBe(409);
    // removing the copy goes back to the built-in
    expect((await removeMod(w.env, 'say')).status).toBe(200);
    expect(fs.existsSync(folder)).toBe(false);
    // a copy of a required mod is required too (the loader keys it by id), so it has no off switch either
    expect((await customizeMod(w.env, 'phase', { trust: true })).status).toBe(200);
    const after = body(await listMods(w.env)).mods as any[];
    expect(after.filter((m) => m.id === 'phase').map((m) => [m.bundled, m.required])).toContainEqual([false, true]);
    expect((await setEnabled(w.env, 'phase', false)).status).toBe(409);
  });

  it('isNewer: the built-in is newer when its version is higher', () => {
    expect(isNewer('1.1.0', '1.0.0')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', '1.0.1')).toBe(false);
    expect(isNewer('2', '1.9.9')).toBe(true);
  });
});

describe('guide: the Share file', () => {
  const useBoth = `${head()}${PING_USE}\n\n## playbook review\ninput: area = x; depth = y\n\n## playbook review\nid: again\ninput: area = y; depth = z\n\n${EXISTS_USE}\n\n${NOSHELL_USE}\n`;
  const PLAYBOOK_NOTE = 'The playbook review is a file in your blocks folder and is not in this file. Whoever imports the file needs a playbook with that name.';

  it('export holds the workflow and the user mods it needs (block, condition, card), never a built-in or the playbook file; import asks one trust per code mod and saves the workflow', async () => {
    const a = await world();
    await install(a, three());
    const r = exportBundle(a.env, { workflow: { name: 'ship', text: useBoth } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const file = JSON.parse(body(r).text);
    expect(Object.keys(file).sort()).toEqual(['mods', 'reinsMods', 'workflow']);
    expect(file.reinsMods).toBe(1);
    expect(Object.keys(file.mods).sort()).toEqual(['card-noshell', 'cond-exists', 'ping']);
    expect(Object.keys(file.mods.ping).sort()).toEqual(['index.js', 'mod.json']);
    expect(file.workflow).toEqual({ name: 'ship', text: useBoth });
    expect(JSON.stringify(file)).not.toContain('Review {{area}}');
    expect(body(r).notes).toEqual([PLAYBOOK_NOTE]);   // once, though two steps read the same file

    const b = await world();
    const preview = importPreview(b.env, body(r).text);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const sum = body(preview).summary;
    expect(sum.envelope).toBe(true);
    expect(sum.mods.map((m: any) => [m.id, m.hasCode]).sort()).toEqual([['card-noshell', true], ['cond-exists', true], ['ping', true]]);
    expect(sum.workflow).toMatchObject({ name: 'ship', exists: false });
    const hashes = Object.fromEntries(sum.mods.map((m: any) => [m.id, m.hash as string]));
    expect((await importApply(b.env, { file: body(r).text, trust: { ...hashes, ping: 'wrong' } })).status).toBe(409);
    expect(fs.existsSync(path.join(b.t.home, 'workflows', 'ship.reins.md'))).toBe(false);
    expect(fs.existsSync(path.join(b.t.modsDir, 'ping'))).toBe(false);   // all or nothing
    const ok = await importApply(b.env, { file: body(r).text, trust: hashes });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(fs.readFileSync(path.join(b.t.home, 'workflows', 'ship.reins.md'), 'utf8')).toBe(useBoth);
    expect(fs.existsSync(path.join(b.t.home, 'workflows', 'blocks'))).toBe(false);
    expect(body(ok).trust).toMatchObject({ ping: 'trusted', 'cond-exists': 'trusted', 'card-noshell': 'trusted' });
    // a second import of the same file is refused: the workflow name is taken
    expect((await importApply(b.env, { file: body(r).text, trust: hashes })).status).toBe(409);
  });

  it('a workflow of built-in blocks only gives a file with no mods', async () => {
    const a = await world();
    const r = exportBundle(a.env, { workflow: { name: 'plain', text: `${head()}## phase One\n> go\n` } });
    expect(r.status).toBe(200);
    expect(JSON.parse(body(r).text).mods).toEqual({});
  });
});

describe('README.md and the guides name what the code has', () => {
  const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const cell = (row: string) => new Set([...read('../../../README.md').split('\n').find((l) => l.startsWith(`| **${row}** |`))!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
  it('the Steps, Conditions and Live cards rows are exactly the registered kinds, conditions and cards', async () => {
    const w = await world();
    const { NODES, CONDS, CARDS } = await import('@reins/core');
    const same = (got: Set<string>, drop: string[], want: string[]) => expect([...got].filter((x) => !drop.includes(x)).sort()).toEqual([...want].sort());
    same(cell('Steps'), ['else', 'blocks/'],[...NODES.keys()]);
    same(cell('Conditions'), ['and', 'or', 'not'], [...CONDS.keys()]);
    same(cell('Live cards'), [], [...CARDS.keys()]);
    void w;
  });
  it('the nodes README example is the fixture, and the order table is the manifests', () => {
    const readme = read('../../core/src/nodes/README.md');
    const code = readme.slice(readme.indexOf('```ts\n// The toy block') + 6, readme.indexOf('```', readme.indexOf('```ts\n// The toy block') + 6)).trim();
    expect(code).toBe(read('../../core/test/fixtures/beep.ts').trim());
    for (const id of ['phase', 'say', 'run', 'gate', 'repeat', 'if', 'verify', 'recall', 'store', 'model', 'subagent', 'end', 'fork', 'playbook']) {
      const m = JSON.parse(read(`../src/mods/${id}/mod.json`));
      expect(readme, id).toContain(`| ${id} | ${m.order} | ${m.view.order} |`);
    }
  });
  it('PACK.md counts the pack as the folders have it: 14 blocks, 11 conditions, 3 cards, all "pack": "default"; only phase and end are required', () => {
    const dirs = fs.readdirSync(new URL('../src/mods/', import.meta.url), { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(new URL(`../src/mods/${d.name}/mod.json`, import.meta.url)));
    const man = dirs.map((d) => ({ id: d.name, ...JSON.parse(read(`../src/mods/${d.name}/mod.json`)) as { kind: string; pack?: string; required?: boolean } })).filter((m) => m.pack === 'default');
    expect(man.filter((m) => m.kind === 'block')).toHaveLength(14);
    expect(man.filter((m) => m.kind === 'condition')).toHaveLength(11);
    expect(man.filter((m) => m.kind === 'card')).toHaveLength(3);
    expect(man.filter((m) => m.required).map((m) => m.id).sort()).toEqual(['end', 'phase']);
    const guide = read('../src/mods/PACK.md');
    expect(guide).toContain('28 of them say');
    for (const m of man) expect(guide.includes(`\`${m.id}\``), m.id).toBe(true);
  });
  it('the limits PACK.md states are the constants in the source', () => {
    const num = (file: string, name: string) => Number(new RegExp(`${name} = ([\\d_]+)`).exec(read(file))![1]!.replaceAll('_', ''));
    const pb = '../src/mods/playbook/index.ts';
    const guide = read('../src/mods/PACK.md');
    const nice = (n: number) => n.toLocaleString('en-US');
    expect(guide).toContain(`At most ${num(pb, 'MAX_INPUTS')} inputs`);
    expect(guide).toContain(`a value is at most ${num(pb, 'MAX_VALUE')} characters`);
    expect(guide).toContain(`at most ${nice(num(pb, 'MAX_STEPS'))} steps and ${num(pb, 'MAX_CHARS') / 1_000_000} million characters`);
    expect(guide).toContain(`up to ${num(pb, 'MAX_SEGMENTS')} levels deep`);
    expect(guide).toContain(`at most ${num(pb, 'MAX_CHECKS')} files`);
    expect(guide).toContain(`${num(pb, 'MAX_SHOWN')} problems at most`);
    expect(guide).toContain(`at most ${nice(num('../src/run-cli.ts', 'BLOCK_MAX'))} bytes`);
    expect(guide).toContain(`the last ${nice(num('../src/mods/fork/index.ts', 'CAP'))} characters`);
    expect(guide).toContain(`cut at ${nice(num('../src/mods/fork/index.ts', 'CAP'))} characters`);
    const actions = read('../src/mods/actions.ts');
    expect(guide).toContain(`At most ${/MAX_MODS = (\d+)/.exec(actions)![1]} mods`);
    expect(guide).toContain(`at most ${Number(/MAX_WORKFLOW = (\d+) \* 1024/.exec(actions)![1])} KB`);
  });
  it('the api.core table of the mod README names exactly the functions the loader hands out', () => {
    const loader = read('../src/mods/loader.ts');
    const given = /core: Object\.freeze\(\{ ([^}]+) \}\)/.exec(loader)![1]!.split(', ').sort();
    expect(given).toHaveLength(9);
    const readme = read('../src/mods/README.md');
    for (const fn of given) expect(readme, fn).toMatch(new RegExp(`\\| \`${fn}\\(`));
    expect(readme).toContain(TRACKS_LINE);   // the manifest words `tracks` and `reads` and the extra trust line are in the mod README
    expect(read('../src/mods/PACK.md')).toContain(TRACKS_LINE);
    for (const word of ['| `tracks` |', '| `reads` |']) expect(readme, word).toContain(word);
  });
});

describe('guide: PACK.md holds the examples', () => {
  it('every example above is in the guide, byte for byte', () => {
    const guide = fs.readFileSync(new URL('../src/mods/PACK.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const all = { PING_MOD, PING_CODE, PING_USE, EXISTS_MOD, EXISTS_CODE, EXISTS_USE, NOSHELL_MOD, NOSHELL_CODE, NOSHELL_USE, FORK_FILE, SHIP_FILE, REVIEW_FILE, INLINE_FILE };
    for (const [name, text] of Object.entries(all)) expect(guide.includes(text), `${name} is not in PACK.md`).toBe(true);
  });
  it('no guide, README or changelog holds the long dash', () => {
    const dash = String.fromCharCode(0x2014);
    for (const f of ['../src/mods/PACK.md', '../src/mods/README.md', '../../core/src/nodes/README.md', '../../../CHANGELOG.md', '../../../README.md']) {
      expect(fs.readFileSync(new URL(f, import.meta.url), 'utf8').includes(dash), f).toBe(false);
    }
  });
});
