import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keeps core, the server and the app free of block, condition and card names: only a pack mod's own folder (packages/server/src/mods/<id>/ with "pack" in its
// mod.json) may name what it brings. The lists of names are built from the pack manifests (`provides.kinds`, `conditions`, `cards`, `ops`, `events`), so a
// new pack mod is covered the day it is added. A name is a hit only as a WHOLE quoted literal ('x', "x", `x`) or as an object or type key (`x:`, `x?:`),
// because words like end, run, if, now or done are common JavaScript and English: a longer text that holds the word is not a hit.
// Two kinds of failure:
//  HARD  the forms that look a block up by name (`step.kind === 'x'`, `['x'].includes(step.kind)`, `{ x: 1 }[step.kind]`, `c.t === 'x'`, `case 'OP'`, `NODES.get('x')`,
//        `KINDS.x`) fail wherever they stand: no allowlist excuses them.
//  OTHER a hit of a plain word (end, run, model, ...) must be an entry of no-kind-branch.allow.json: the EXACT TEXT of the line (trimmed), per name and file, with
//        a reason per name. A changed line, a new line, a copy of an allowed line and a line gone from the code are all found, whatever the counts.
// A comment that starts a line (`//`, `*`, `/* ... */`) is cut off before the line is read; the rest of the line is read. Every hit counts, not every line.
// Limits: a computed lookup (KINDS[x]) and a name put together at run time ('en' + 'd') are not seen; a block comment that goes on over lines is read line by line.

const modsDir = fileURLToPath(new URL('../../server/src/mods', import.meta.url));
interface Manifest { pack?: unknown; provides?: { kinds?: string[]; conditions?: string[]; cards?: string[]; ops?: string[]; events?: string[] } }
const manifestOf = (d: string): Manifest => JSON.parse(readFileSync(join(modsDir, d, 'mod.json'), 'utf8')) as Manifest;
const packDirs = (): string[] => readdirSync(modsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(modsDir, e.name, 'mod.json')) && manifestOf(e.name).pack !== undefined).map((e) => e.name);
const PACK_DIRS = packDirs();
const provided = (key: 'kinds' | 'conditions' | 'cards' | 'ops' | 'events'): string[] => [...new Set(packDirs().flatMap((d) => manifestOf(d).provides?.[key] ?? []))];

interface Rule { name: string; re: RegExp }
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const Q = '([\'"`])';   // an opening quote of any of the three kinds; `\1` closes it
/** A name as a whole quoted literal (any of the three quotes), or as a key: `{ name: 1 }`, `name?: T`, a line that starts with `name:`. */
const nameRules = (names: string[]): Rule[] => names.flatMap((n) => [{ name: n, re: new RegExp(`${Q}${esc(n)}\\1`) }, { name: n, re: new RegExp(`(?:^|[{,;(])\\s*${esc(n)}\\??\\s*:`) }]);
// The events of the kinds: a quoted name is a read; a name with an underscore is also caught as an object key (`verify_result: ...`), which the common words are not.
const eventRules = (events: string[]): Rule[] => [
  ...events.map((e) => ({ name: e, re: new RegExp(`['"\`]${esc(e)}['"\`]`) })),
  ...events.filter((e) => e.includes('_')).map((e) => ({ name: e, re: new RegExp(`\\b${esc(e)}\\s*:`) })),
];
// The forms that name a kind without a quoted literal: the app's `KINDS.gate` and `KINDS['gate']`.
const lookupRules = (kinds: string[]): Rule[] => kinds.map((k) => ({ name: k, re: new RegExp(`KINDS(?:\\.|\\[\\s*['"\`])${esc(k)}\\b`) }));
// HARD: the receivers that hold a block (`step`, `s`, ...) and a condition (`c`, `cond`, ...). `q.kind === 'gate'` (a question) and `ans.t === 'stop'` (an answer) are
// other things with the same word, so they are left to the exact-text list; a block or a condition is never looked up by name in core, the server or the app.
const BLOCK = '(?:step|s|st|node|instr|block|first|prev|next|it|item|b)';
const COND = '(?:c|cond|atom|a)';
const hardRules = (kinds: string[], conds: string[], ops: string[]): Rule[] => [
  ...kinds.flatMap((k) => [
    { name: k, re: new RegExp(`\\b${BLOCK}\\??\\.kind\\s*[!=]==?\\s*${Q}${esc(k)}\\1`) },
    { name: k, re: new RegExp(`${Q}${esc(k)}\\1\\s*[!=]==?\\s*${BLOCK}\\??\\.kind\\b`) },
    { name: k, re: new RegExp(`\\[[^\\]]*${Q}${esc(k)}\\1[^\\]]*\\]\\.includes\\(\\s*${BLOCK}\\??\\.kind\\b`) },
    { name: k, re: new RegExp(`\\{[^}]*\\b${esc(k)}\\s*:[^}]*\\}\\s*\\[\\s*(?:${BLOCK}\\??\\.)?kind\\s*\\]`) },
    { name: k, re: new RegExp(`NODES\\.get\\(\\s*${Q}${esc(k)}\\1`) },
    { name: k, re: new RegExp(`KINDS(?:\\.|\\[\\s*['"\`])${esc(k)}\\b`) },
  ]),
  ...conds.flatMap((c) => [
    { name: c, re: new RegExp(`\\b${COND}\\??\\.t\\s*[!=]==?\\s*${Q}${esc(c)}\\1`) },
    { name: c, re: new RegExp(`${Q}${esc(c)}\\1\\s*[!=]==?\\s*${COND}\\??\\.t\\b`) },
  ]),
  ...ops.map((o) => ({ name: o, re: new RegExp(`\\bcase\\s+${Q}${esc(o)}\\1`) })),
];
const KIND_EVENTS = ['gate_paused', 'loop_iteration', 'loop_budget_exceeded', 'verify_result'];
const NAME_RULES = [...nameRules([...provided('kinds'), ...provided('conditions'), ...provided('cards'), ...provided('ops')]), ...lookupRules(provided('kinds'))];
const EVENT_RULES = eventRules([...new Set([...KIND_EVENTS, ...provided('events')])]);
const HARD_RULES = hardRules(provided('kinds'), provided('conditions'), provided('ops'));
const CSS = /\[data-kind=/;

/** The code of a line: a comment that starts it (`//`, `*`, any number of leading block comments on one line) and a trailing ` // ...` are cut off. */
const codeOf = (line: string): string => {
  let c = line.trim();
  while (c.startsWith('/*') && c.includes('*/')) c = c.slice(c.indexOf('*/') + 2).trim();
  if (c.startsWith('//') || c.startsWith('*') || c.startsWith('/*')) return '';
  return c.replace(/\s\/\/\s.*$/, '');
};
/** The names a line holds (each once per line; the counting is by line text below). `names` and `events` are off inside a pack mod's own folder. */
const hitNames = (line: string, file: string, names = true, events = true, rules = { name: NAME_RULES, event: EVENT_RULES }): string[] => {
  const code = codeOf(line);
  if (file.endsWith('.css')) return CSS.test(code) ? ['[data-kind]'] : [];
  return [...new Set([...(names ? rules.name : []), ...(events ? rules.event : [])].filter((r) => r.re.test(code)).map((r) => r.name))];
};
const hit = (line: string, file = 'packages/core/src/a.ts', rules?: { name: Rule[]; event: Rule[] }): boolean => hitNames(line, file, true, true, rules).length > 0;
/** The names a line looks up by a hard form. */
const hardNames = (line: string, rules = HARD_RULES): string[] => { const code = codeOf(line); return [...new Set(rules.filter((r) => r.re.test(code)).map((r) => r.name))]; };

/** Every hit of one file's text; `rel` is its path from the repo root. Nothing inside a pack mod's own folder. */
export function hitsIn(text: string, rel: string): Array<{ n: number; name: string; text: string; hard: boolean }> {
  if (PACK_DIRS.some((d) => rel.startsWith(`packages/server/src/mods/${d}/`))) return [];
  return text.split('\n').flatMap((raw, i) => {
    const hard = new Set(hardNames(raw));
    return [...new Set([...hitNames(raw, rel), ...hard])].map((name) => ({ n: i + 1, name, text: raw.trim(), hard: hard.has(name) }));
  });
}

// For each plain word: why it may stand, and the exact text of every line (trimmed) that holds it, per file. Most are plain words of the language: `model` (the
// model a request names), `stop` (the stop control), `done`, `now`, `run`, `end` (a range end, a stream's `end` event) that also happen to be the name of a pack block,
// condition or card. The list is data: packages/core/test/no-kind-branch.allow.json.
interface Allow { reason: string; files: Record<string, string[]> }
const loadAllow = (): Record<string, Allow> => JSON.parse(readFileSync(fileURLToPath(new URL('./no-kind-branch.allow.json', import.meta.url)), 'utf8')) as Record<string, Allow>;

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

/** Every file of the three packages' `src`, as { rel, text } with the line ends made plain. */
export const sources = () => readdirSync(join(root, 'packages')).flatMap((p) => existsSync(join(root, 'packages', p, 'src')) ? walk(join(root, 'packages', p, 'src')) : [])
  .map((f) => ({ rel: relative(root, f).replace(/\\/g, '/'), text: readFileSync(f, 'utf8').replace(/\r/g, '') }));

/** What is wrong with a set of files: lookups by name (`hard`), lines the list does not allow (`bad`), lines in the list that no file holds (`stale`), entries with no reason. */
export function scan(files: Array<{ rel: string; text: string }>, allow: Record<string, Allow> = loadAllow()) {
  const hard: string[] = [], bad: string[] = [], seen: Record<string, Record<string, string[]>> = {};
  for (const { rel, text } of files) for (const h of hitsIn(text, rel)) {
    if (h.hard) hard.push(`${h.name} in ${rel}:${h.n}: ${h.text}`);
    else ((seen[h.name] ??= {})[rel] ??= []).push(h.text);
  }
  const stale: string[] = [];
  for (const [name, byFile] of Object.entries(seen)) for (const [file, texts] of Object.entries(byFile)) {
    const left = [...(allow[name]?.files[file] ?? [])];
    for (const t of texts) { const i = left.indexOf(t); if (i === -1) bad.push(`${name} in ${file}: ${t}`); else left.splice(i, 1); }
  }
  for (const [name, a] of Object.entries(allow)) for (const [file, texts] of Object.entries(a.files)) {
    const left = [...(seen[name]?.[file] ?? [])];
    for (const t of texts) { const i = left.indexOf(t); if (i === -1) stale.push(`${name} in ${file}: ${t}`); else left.splice(i, 1); }
  }
  const noReason = Object.entries(allow).filter(([, a]) => a.reason.length < 20).map(([name]) => name);
  return { hard, bad, stale, noReason };
}
const clean = { hard: [], bad: [], stale: [], noReason: [] };

describe('no pack names outside the pack folders', () => {
  it('the lists come from the manifests', () => {
    expect(provided('kinds')).toEqual(expect.arrayContaining(['phase', 'say', 'run', 'gate', 'repeat', 'if', 'verify', 'recall', 'store', 'model', 'subagent', 'end', 'fork', 'playbook']));
    expect(provided('conditions')).toEqual(expect.arrayContaining(['attempts', 'approve', 'done', 'same', 'cmd', 'diff', 'review', 'llm', 'tests']));
    expect(provided('cards')).toEqual(expect.arrayContaining(['now', 'guard', 'stop']));
    expect(provided('ops')).toContain('LOOP_IN');
  });

  it('the matcher bites: every spelling of a kind, condition, card or op name', () => {
    const planted = [
      "const a = 'subagent';", 'const b = "end";', 'if (xs.includes(\'gate\')) {}', 'const c = { recall: 1 };', "const X = 'verify'",
      'const d = `playbook`;', "if (c.t === 'tests') {}", "case 'LOOP_IN':", "if (k === 'guard') {}", 'x = { done: true };', '  store: Store;', 'f(q, { same: 2 })', 'KINDS.gate',
      "NODES.get('fork')", 'const e = { end?: number };', "return 'approve';", "KINDS['model']",
      "/* x */ if (step.kind === 'end') continue;", 'if (kind == "recall") {}',
    ];
    for (const p of planted) expect(hit(p), p).toBe(true);
  });

  it('the matcher is quiet on longer text, comments, other names and words that only contain a name', () => {
    const quiet = [
      "const t = 'the end of the line';", "say('run the tests');", '// the "end" block', ' * a `gate` card', '/* if */', "const x = 'ending';", "const y = 'subagents';",
      'const ended = true;', 'const store: Map<string, number> = new Map();', 'f(end)', 'const run = 1;', "const z = 'done_by';", 'let a = b ? end : now;', 'x = y // the "end"',
      "/* the 'end' block */ /* and 'gate' */", '/* a */ // "gate"',
    ];
    for (const q of quiet) expect(hit(q), q).toBe(false);
  });

  it('the hard forms bite, whatever the word, and are quiet on a question or an answer', () => {
    const hardLines = [
      "if (step.kind === 'end') continue;", 'if (s.kind !== "gate") {}', "if ('recall' === node?.kind) {}", "['store'].includes(step.kind)", 'const M = { repeat: 1 }[kind];',
      'const M = { repeat: 1 }[step.kind];', "if (c.t === 'tests') {}", "if (cond.t !== 'approve') {}", "case 'LOOP_IN':", "NODES.get('verify')", 'KINDS.model', "KINDS['subagent']",
      "/* note */ if (step.kind == 'end') {}", "if (a.t === 'same' || x) {}",
    ];
    for (const l of hardLines) expect(hardNames(l).length, l).toBeGreaterThan(0);
    const soft = ["if (q.kind === 'gate') {}", "if (ans.t === 'approve') run.approve();", "if (kind === 'stop') {}", "if (card.kind === 'now') {}", 'NODES.get(step.kind)', 'const gate = 1;', "// if (step.kind === 'end') {}"];
    for (const l of soft) expect(hardNames(l), l).toEqual([]);
  });

  it('the event matcher bites: a quoted kind event, a keyed one, a double-quoted one; not a core event', () => {
    expect(hit("if (ev.type === 'verify_result') say('x');", 'a.ts')).toBe(true);
    expect(hit('if (ev.type === "model_switched") {}', 'a.ts')).toBe(true);
    expect(hit('const t = `loop_iteration`;', 'a.ts')).toBe(true);
    expect(hit("  gate_paused: (m, cur, d) => {", 'a.ts')).toBe(true);
    expect(hit("ev.type === 'gate_approved'", 'a.ts')).toBe(false);
    expect(hit("ev.type === 'subagent_result'", 'a.ts')).toBe(false);
  });

  it('the css matcher bites only in css', () => {
    expect(hit("[data-kind='end'] {}", 'a.css')).toBe(true);
    expect(hit('.end { color: red }', 'a.css')).toBe(false);
  });

  it('the pack manifests add their names to the lists', () => {
    const own = { name: nameRules(['beeped']), event: eventRules(['beeped_twice']) };
    expect(hit("f('beeped')", 'a.ts', own)).toBe(true);
    expect(hit("f('beeped twice')", 'a.ts', own)).toBe(false);
    expect(hit('beeped_twice: () => 1', 'a.ts', own)).toBe(true);
  });

  it('a pack mod\'s own folder may name what it brings', () => {
    expect(hitsIn("export const k = 'repeat';\n", 'packages/server/src/mods/repeat/index.ts')).toEqual([]);
    expect(hitsIn("export const k = 'repeat';\n", 'packages/server/src/mods/other/index.ts')).toHaveLength(1);
  });

  it('no file looks a block up by name, and every other hit of a plain word is an exact line of the list', () => {
    expect(scan(sources())).toEqual(clean);
  });

  it('the list is exact: a new line, a changed line, a copy of a line, a removed line and a missing reason are all found', () => {
    const allow = { end: { reason: 'a range end, not the end block', files: { 'a.ts': ['x = { end: 1 };', 'f(y, "end");'] } }, run: { reason: 'short', files: { 'b.ts': ['run: () => 1,'] } } };
    const base = 'x = { end: 1 };\nf(y, "end");\n';
    const one = (text: string, al = allow) => scan([{ rel: 'a.ts', text }], al);
    expect(one(base)).toEqual({ hard: [], bad: [], stale: ['run in b.ts: run: () => 1,'], noReason: ['run'] });
    expect(one(`${base}f(y, "end");\n`).bad).toEqual(['end in a.ts: f(y, "end");']);                       // a copy of an allowed line
    expect(one('x = { end: 1 };\nf(y, "end"); g();\n').bad).toEqual(['end in a.ts: f(y, "end"); g();']);   // a changed line
    expect(one('x = { end: 1 };\n').stale).toContain('end in a.ts: f(y, "end");');                         // a removed line
    expect(scan([{ rel: 'a.ts', text: base }, { rel: 'c.ts', text: 'x = { end: 1 };\n' }], allow).bad).toEqual(['end in c.ts: x = { end: 1 };']);   // the same text in another file
    expect(one(`${base}const g = "gate";\n`).bad).toEqual(['gate in a.ts: const g = "gate";']);
    const planted = `${base}if (step.kind === "end") f();\n`;
    expect(one(planted).hard).toHaveLength(1);                                                               // a hard form is found
    const excused = { ...allow, end: { ...allow.end, files: { 'a.ts': [...allow.end.files['a.ts']!, 'if (step.kind === "end") f();'] } } };
    expect(one(planted, excused).hard).toHaveLength(1);                                                      // and no list excuses it
  });

  it('the plants the re-check used are found, in the real files', () => {
    const files = sources();
    const core = (f: string) => `packages/core/src/${f}`;
    const addTo = (needle: string, extra: string) => (text: string) => {
      const ls = text.split('\n'), i = ls.findIndex((l) => l.includes(needle));
      expect(i, needle).toBeGreaterThan(-1);
      ls[i] = ls[i] + extra;
      return ls.join('\n');
    };
    const addLine = (line: string) => (text: string) => `${line}\n${text}`;
    const gateLine = "this.awaiting(track, 'gate')";
    const plants: Array<[string, string, (t: string) => string]> = [
      ['appended to a line that already holds gate', core('run.ts'), addTo(gateLine, " if ((this.program[this.programCounter] as { kind?: string })?.kind === 'gate') return false;")],
      ['a new line that starts with a comment', core('validate.ts'), addLine("/* PLANT2 */ if (step.kind === 'end') continue;")],
      ['a loose equals and a bare kind', core('validate.ts'), addLine('if (kind == "recall") continue;')],
      ['an array that includes the kind', core('validate.ts'), addLine("if (['store'].includes(step.kind)) continue;")],
      ['a switch on the kind', core('validate.ts'), addLine("switch (kind) { case 'verify': break; }")],
      ['an object indexed by the kind', core('validate.ts'), addLine('const M = { repeat: 1 }[kind];')],
      ['a condition by .t', core('validate.ts'), addLine("if (c.t === 'tests') continue;")],
      ['a registry lookup', core('validate.ts'), addLine("const n = NODES.get('fork');")],
      ['a second copy of an allowed line', core('run.ts'), addTo(gateLine, `\n${'const f = this.awaiting(track, \'gate\');'}`)],
    ];
    // Only the planted file is scanned, against the list's entries for that file (the whole tree is scanned once, above).
    for (const [what, rel, edit] of plants) {
      const file = files.find((f) => f.rel === rel)!;
      const allowHere = Object.fromEntries(Object.entries(loadAllow()).map(([n, a]) => [n, { ...a, files: Object.fromEntries(Object.entries(a.files).filter(([f]) => f === rel)) }]));
      expect(scan([file], allowHere), `${what}: untouched`).toEqual(clean);
      const r = scan([{ ...file, text: edit(file.text) }], allowHere);
      expect(r.hard.length + r.bad.length, what).toBeGreaterThan(0);
    }
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
