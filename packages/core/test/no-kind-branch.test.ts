import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keeps the engine and the app free of block names: only core/src/nodes/ may branch on a kind.
// Limits: it checks a finite list of names and spellings. It misses double quotes, template
// strings, computed lookups (KINDS[x]) and future kind names.

const KINDS = 'phase|say|run|gate|repeat|if|verify|recall|store|model|subagent|end|fork';
const OPS = 'RECALL|GATE|IF|LOOP_IN|RUN|LOOP_BK|VERIFY|STORE|FORK';
const ANY: RegExp[] = [
  new RegExp(`kind\\s*[!=]==\\s*'(${KINDS})'`),
  new RegExp(`case '(${OPS})'`),
  new RegExp(`op\\s*[!=]==\\s*'(${OPS})'`),
  new RegExp(`NODES\\.get\\('(${KINDS})'\\)`),
  new RegExp(`KINDS(\\.|\\[')(${KINDS})\\b`),
  new RegExp(`addStepAt\\([^)]*'(${KINDS})'`),
];
const CSS = /\[data-kind=/;

// The events of the kinds (M3 Task 2): no file outside core/src/nodes (and a pack mod's own folder) reads one by name. The kind's `count`, `print` and view
// (`status`, `hidden`) carry them. Events core logs itself (run_*, turn_ended, refusal, card_*, engine_cost, subagent_*, gate_approved, link_*) stay by name.
// The list is the events of the built-in kinds plus every `provides.events` of a pack manifest (packages/server/src/mods/<id>/mod.json with "pack").
// A quoted name is a read; a name with an underscore is also caught as an object key (`verify_result: ...`), which the common words recall and store are not.
const KIND_EVENTS = ['gate_paused', 'loop_iteration', 'loop_budget_exceeded', 'verify_result', 'recall', 'store'];
const modsDir = fileURLToPath(new URL('../../server/src/mods', import.meta.url));
const packDirs = (): string[] => readdirSync(modsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(modsDir, e.name, 'mod.json')) && (JSON.parse(readFileSync(join(modsDir, e.name, 'mod.json'), 'utf8')) as { pack?: unknown }).pack !== undefined).map((e) => e.name);
const packEvents = (): string[] => packDirs().flatMap((d) => ((JSON.parse(readFileSync(join(modsDir, d, 'mod.json'), 'utf8')) as { provides?: { events?: string[] } }).provides?.events ?? []));
const eventRules = (events: string[]): RegExp[] => [
  ...events.map((e) => new RegExp(`['"\`]${e}['"\`]`)),
  ...events.filter((e) => e.includes('_')).map((e) => new RegExp(`\\b${e}\\s*:`)),
];
const EVENT_RULES = eventRules([...new Set([...KIND_EVENTS, ...packEvents()])]);

// A pack mod's own folder may name its own kinds and ops (`own`); every other name is still a branch on a kind.
const packNames = (d: string): string[] => { const p = (JSON.parse(readFileSync(join(modsDir, d, 'mod.json'), 'utf8')) as { provides?: { kinds?: string[]; ops?: string[] } }).provides; return [...(p?.kinds ?? []), ...(p?.ops ?? [])]; };
const hit = (line: string, file: string, events = true, own: string[] = []) => ANY.some((r) => { const m = r.exec(line); return m !== null && !own.includes(m[m.length - 1]!); }) || (events && EVENT_RULES.some((r) => r.test(line))) || (file.endsWith('.css') && CSS.test(line));

const ALLOW = [
  // The reserved event names: RunEvents is the type of every event type, CORE_EVENTS the list a mod's row can not cover (m2-fix-25a-a pins the two equal).
  // Each kind's names leave both with the kind (M3 Tasks 3 to 8), where its mod declares them in `provides.events`.
  { file: 'packages/server/src/drive.ts', text: "if (kind === 'gate') {", reason: 'a question kind, core pause type' },
  { file: 'packages/server/src/run-cli.ts', text: "if (o.yes && q.kind === 'gate') { say('  approved (--yes)'); return Promise.resolve('approve'); }", reason: 'a question kind, core pause type' },
];

const root = fileURLToPath(new URL('../../..', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('no block names outside core/src/nodes', () => {
  it('the matcher bites', () => {
    expect(hit("if (x.kind === 'end') {}", 'a.ts')).toBe(true);
    expect(hit("kind === 'foo'", 'a.ts')).toBe(false);
    expect(hit("[data-kind='end'] {}", 'a.css')).toBe(true);
    expect(hit("[data-kind='end'] {}", 'a.ts')).toBe(false);
  });

  it('the event matcher bites: a quoted kind event, a keyed one, a double-quoted one; not a core event, not a common word', () => {
    expect(hit("if (ev.type === 'verify_result') say('x');", 'a.ts')).toBe(true);
    expect(hit('if (ev.type === "model_switched") {}', 'a.ts')).toBe(true);
    expect(hit('const t = `loop_iteration`;', 'a.ts')).toBe(true);
    expect(hit("  gate_paused: (m, cur, d) => {", 'a.ts')).toBe(true);
    expect(hit("case 'recall':", 'a.ts')).toBe(true);
    expect(hit("ev.type === 'store'", 'a.ts')).toBe(true);
    expect(hit("ev.type === 'gate_approved'", 'a.ts')).toBe(false);
    expect(hit("ev.type === 'subagent_result'", 'a.ts')).toBe(false);
    expect(hit('const store: Store = x; // recall the store', 'a.ts')).toBe(false);
  });

  it('the pack manifests add their events to the list', () => {
    const rules = eventRules(['beeped_twice']);
    expect(rules.some((r) => r.test("log('beeped_twice', {})"))).toBe(true);
    expect(rules.some((r) => r.test('beeped_twice: () => 1'))).toBe(true);
    expect(rules.some((r) => r.test("log('beeped', {})"))).toBe(false);
  });

  it('a pack mod\'s own folder may name its own kinds and ops, and nothing else', () => {
    expect(hit("p.op === 'LOOP_IN'", 'a.ts')).toBe(true);
    expect(hit("p.op === 'LOOP_IN'", 'a.ts', true, ['repeat', 'LOOP_IN', 'LOOP_BK'])).toBe(false);
    expect(hit("p.op === 'RUN'", 'a.ts', true, ['repeat', 'LOOP_IN', 'LOOP_BK'])).toBe(true);
    expect(hit("x.kind === 'run'", 'a.ts', true, ['repeat', 'LOOP_IN'])).toBe(true);
    expect(hit("x.kind === 'repeat'", 'a.ts', true, ['repeat', 'LOOP_IN'])).toBe(false);
    expect(packNames('repeat')).toEqual(['repeat', 'LOOP_IN', 'LOOP_BK']);
  });

  it('no file branches on a kind, and the allowlist is exact', () => {
    const files = readdirSync(join(root, 'packages')).flatMap((p) => existsSync(join(root, 'packages', p, 'src')) ? walk(join(root, 'packages', p, 'src')) : []);
    const packs = packDirs();
    const used = new Set<number>();
    const bad: string[] = [];
    for (const f of files) {
      const rel = relative(root, f).replace(/\\/g, '/');
      if (rel.startsWith('packages/core/src/nodes/')) continue;
      const ownEvents = packs.some((d) => rel.startsWith(`packages/server/src/mods/${d}/`));   // a pack mod names its own events
      const own = packs.filter((d) => rel.startsWith(`packages/server/src/mods/${d}/`)).flatMap(packNames);   // and its own kinds and ops
      readFileSync(f, 'utf8').split('\n').forEach((raw, n) => {
        const line = raw.trim();
        if (!hit(line, rel, !ownEvents, own)) return;
        const k = ALLOW.findIndex((a) => a.file === rel && a.text === line);
        if (k >= 0) used.add(k);
        else bad.push(`${rel}:${n + 1}: ${line}`);
      });
    }
    const stale = ALLOW.filter((_, k) => !used.has(k)).map((a) => `${a.file}: ${a.text}`);
    expect({ bad, stale }).toEqual({ bad: [], stale: [] });
  });
});

// M3 Task 8: no kind, condition or card has a file under core/src. They are mods of the default pack (packages/server/src/mods/<id>/). What stays is exact:
//  nodes/index.ts   the registry and the shared types of a block
//  nodes/fields.ts  the view types the registry and the app share
//  nodes/turn.ts    `turnInstr`, `policyOf`, `checkMode`: the helpers a block gets through `api.core`
//  nodes/README.md  the recipe
//  conds/index.ts, cards/index.ts   the registries (`CONDS`, `registerCondition`, `CARDS`, `registerCard`)
// The shared types of conditions and cards are cond.ts and the cards/index.ts interface; the registries hold no atom or card of their own.
describe('no kind, condition or card file under core/src', () => {
  const src = join(root, 'packages/core/src');
  const STAYS = [
    'nodes/README.md', 'nodes/fields.ts', 'nodes/index.ts', 'nodes/turn.ts',
    'conds/index.ts', 'cards/index.ts',
  ];
  const under = (dir: string): string[] => (existsSync(join(src, dir)) ? walkAll(join(src, dir)).map((f) => relative(src, f).replace(/\\/g, '/')) : []);
  function walkAll(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walkAll(join(dir, e.name), out);
      else out.push(join(dir, e.name));
    }
    return out;
  }

  it('the matcher bites: a file that is not on the list is found', () => {
    const left = (files: string[]) => files.filter((f) => !STAYS.includes(f));
    expect(left(['conds/tests.ts', 'nodes/say.ts', 'cards/guard.ts', 'nodes/index.ts'])).toEqual(['conds/tests.ts', 'nodes/say.ts', 'cards/guard.ts']);
  });

  it('nodes/, conds/ and cards/ hold only the registries and the shared pieces', () => {
    const files = [...under('nodes'), ...under('conds'), ...under('cards')].sort();
    expect(files).toEqual([...STAYS].sort());
  });

  it('the registries register nothing themselves', () => {
    for (const f of ['conds/index.ts', 'cards/index.ts']) {
      const text = readFileSync(join(src, f), 'utf8');
      expect(text, f).not.toMatch(/^import .* from '\.\/[a-z]+\.js';/m);   // no atom or card file to import
      expect(text, f).not.toMatch(/registerCondition\(\w+, \d+\)|registerCard\(\w+, \d+\)/);
    }
  });

  it('every condition and card of the default pack is a mod folder', () => {
    const mods = readdirSync(modsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^(cond|card)-/.test(e.name)).map((e) => e.name);
    expect(mods.filter((m) => m.startsWith('cond-')).length).toBe(11);
    expect(mods.filter((m) => m.startsWith('card-')).length).toBe(3);
    for (const m of mods) expect((JSON.parse(readFileSync(join(modsDir, m, 'mod.json'), 'utf8')) as { pack?: unknown }).pack, m).toBe('default');
  });
});
