import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keeps core, the server and the app free of block, condition and card names: only a pack mod's own folder (packages/server/src/mods/<id>/ with "pack" in its
// mod.json) may name what it brings. The lists of names are built from the pack manifests (`provides.kinds`, `conditions`, `cards`, `ops`, `events`), so a
// new pack mod is covered the day it is added. A name is a hit only as a WHOLE quoted literal ('x', "x", `x`) or as an object or type key (`x:`, `x?:`),
// because words like end, run, if, now or done are common JavaScript and English: a longer text that holds the word is not a hit, and neither is a comment.
// Limits: a computed lookup (KINDS[x]) and a name put together at run time ('en' + 'd') are not seen.

const modsDir = fileURLToPath(new URL('../../server/src/mods', import.meta.url));
interface Manifest { pack?: unknown; provides?: { kinds?: string[]; conditions?: string[]; cards?: string[]; ops?: string[]; events?: string[] } }
const manifestOf = (d: string): Manifest => JSON.parse(readFileSync(join(modsDir, d, 'mod.json'), 'utf8')) as Manifest;
const packDirs = (): string[] => readdirSync(modsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(modsDir, e.name, 'mod.json')) && manifestOf(e.name).pack !== undefined).map((e) => e.name);
const provided = (key: 'kinds' | 'conditions' | 'cards' | 'ops' | 'events'): string[] => [...new Set(packDirs().flatMap((d) => manifestOf(d).provides?.[key] ?? []))];

interface Rule { name: string; re: RegExp }
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A name as a whole quoted literal (any of the three quotes), or as a key: `{ name: 1 }`, `name?: T`, a line that starts with `name:`. */
const nameRules = (names: string[]): Rule[] => names.flatMap((n) => [{ name: n, re: new RegExp(`(['"\`])${esc(n)}\\1`) }, { name: n, re: new RegExp(`(?:^|[{,;(])\\s*${esc(n)}\\??\\s*:`) }]);
// The events of the kinds: a quoted name is a read; a name with an underscore is also caught as an object key (`verify_result: ...`), which the common words are not.
const eventRules = (events: string[]): Rule[] => [
  ...events.map((e) => ({ name: e, re: new RegExp(`['"\`]${esc(e)}['"\`]`) })),
  ...events.filter((e) => e.includes('_')).map((e) => ({ name: e, re: new RegExp(`\\b${esc(e)}\\s*:`) })),
];
// The forms that name a kind without a quoted literal: the app's `KINDS.gate` and `KINDS['gate']`.
const lookupRules = (kinds: string[]): Rule[] => kinds.map((k) => ({ name: k, re: new RegExp(`KINDS(?:\\.|\\[')${esc(k)}\\b`) }));
const KIND_EVENTS = ['gate_paused', 'loop_iteration', 'loop_budget_exceeded', 'verify_result'];
const NAME_RULES = [...nameRules([...provided('kinds'), ...provided('conditions'), ...provided('cards'), ...provided('ops')]), ...lookupRules(provided('kinds'))];
const EVENT_RULES = eventRules([...new Set([...KIND_EVENTS, ...provided('events')])]);
const CSS = /\[data-kind=/;

const skipLine = (l: string) => l.startsWith('//') || l.startsWith('*') || l.startsWith('/*');
/** The names a line holds (each once). `names` and `events` are off inside a pack mod's own folder. */
const hitNames = (line: string, file: string, names = true, events = true, rules = { name: NAME_RULES, event: EVENT_RULES }): string[] => {
  if (skipLine(line.trim())) return [];
  const code = line.trim().replace(/\s\/\/\s.*$/, '');
  if (file.endsWith('.css')) return CSS.test(code) ? ['[data-kind]'] : [];
  return [...new Set([...(names ? rules.name : []), ...(events ? rules.event : [])].filter((r) => r.re.test(code)).map((r) => r.name))];
};
const hit = (line: string, file = 'packages/core/src/a.ts', rules?: { name: Rule[]; event: Rule[] }): boolean => hitNames(line, file, true, true, rules).length > 0;

/** { name: { file: how many lines hold it } } for one file's text; `rel` is its path from the repo root. Nothing inside a pack mod's own folder. */
export function hitsIn(text: string, rel: string): Array<{ n: number; name: string; text: string }> {
  const inPack = packDirs().some((d) => rel.startsWith(`packages/server/src/mods/${d}/`));
  return text.split('\n').flatMap((raw, i) => hitNames(raw, rel, !inPack, !inPack).map((name) => ({ n: i + 1, name, text: raw.trim() })));
}

// Exact: for each name, why it may stand in the files listed and how many lines of each hold it. A file or a count that differs fails the test, so a new use is
// seen and a removed one is taken off the list. Most are plain words of the language: `model` (the model a request names), `stop` (the stop control), `done`,
// `now`, `run`, `end` (a range end, a stream's `end` event) that also happen to be the name of a pack block, condition or card.
const ALLOW: Record<string, { reason: string; files: Record<string, number> }> = {
  now: {
    reason: "the live-card word `now` (steer / now / stop): core's LiveCardKind and interrupt, the session's card route, the app's composer buttons; also `now` as a clock function (`opts.now`). Control vocabulary, not a lookup of the card mod.",
    files: {
      'packages/app/src/Chat.tsx': 1,
      'packages/app/src/Composer.tsx': 3,
      'packages/app/src/Rail.tsx': 1,
      'packages/app/src/RunDock.tsx': 2,
      'packages/app/src/api.ts': 1,
      'packages/app/src/feed.ts': 2,
      'packages/app/src/panelEdit.ts': 1,
      'packages/app/src/rows.tsx': 1,
      'packages/app/src/runState.ts': 3,
      'packages/core/src/cards/index.ts': 1,
      'packages/core/src/run.ts': 10,
      'packages/server/src/catalog.ts': 1,
      'packages/server/src/live-models.ts': 1,
      'packages/server/src/loop/paths.ts': 1,
      'packages/server/src/loop/retry.ts': 2,
      'packages/server/src/loop/tools.ts': 2,
      'packages/server/src/recover.ts': 1,
      'packages/server/src/run-cli.ts': 1,
      'packages/server/src/server.ts': 1,
      'packages/server/src/session.ts': 5,
    },
  },
  stop: {
    reason: "the live-card and pause word `stop`: run.stop(), PauseReason 'stop', the stop button and /stop, the answer word of a question. Core's control vocabulary, not a lookup of the card mod.",
    files: {
      'packages/app/src/Composer.tsx': 4,
      'packages/app/src/RunDock.tsx': 4,
      'packages/app/src/api.ts': 1,
      'packages/app/src/questions.ts': 1,
      'packages/core/src/cards/index.ts': 1,
      'packages/core/src/nodes/index.ts': 1,
      'packages/core/src/run.ts': 17,
      'packages/server/src/cli.ts': 2,
      'packages/server/src/drive.ts': 11,
      'packages/server/src/loop/engine.ts': 7,
      'packages/server/src/loop/fileio.ts': 1,
      'packages/server/src/loop/types.ts': 1,
      'packages/server/src/questions/budget.ts': 1,
      'packages/server/src/questions/gate.ts': 1,
      'packages/server/src/questions/resume.ts': 1,
      'packages/server/src/questions/usd.ts': 1,
      'packages/server/src/run-cli.ts': 4,
      'packages/server/src/serve.ts': 1,
      'packages/server/src/server.ts': 2,
      'packages/server/src/session.ts': 16,
    },
  },
  end: {
    reason: "a position or span called end: a text range, a stream's 'end' event, the canvas drop zone and `top: 'end'` hit (the cap is found by its view's `stops`, never by name), a feed row's end time.",
    files: {
      'packages/app/src/BlocksPane.tsx': 2,
      'packages/app/src/TextTab.tsx': 1,
      'packages/app/src/Workspace.tsx': 1,
      'packages/app/src/arrange.ts': 3,
      'packages/app/src/blocks.ts': 1,
      'packages/app/src/feed.ts': 4,
      'packages/app/src/gesture.ts': 3,
      'packages/app/src/tags.ts': 3,
      'packages/core/src/viewShape.ts': 1,
      'packages/server/src/mods/claude-code-cli/hooks.ts': 1,
      'packages/server/src/mods/claude-code-cli/mcp.ts': 1,
      'packages/server/src/server.ts': 1,
    },
  },
  model: {
    reason: "the model a request, setting, usage row or field names (`model:` data, the 'model' field input, JudgeKind): data about the model in use, not the model block.",
    files: {
      'packages/app/src/BlockPanel.tsx': 1,
      'packages/app/src/BlocksPane.tsx': 1,
      'packages/app/src/Chat.tsx': 1,
      'packages/app/src/Providers.tsx': 1,
      'packages/app/src/state.ts': 3,
      'packages/app/src/stepStatus.ts': 1,
      'packages/app/src/usage.ts': 4,
      'packages/core/src/cond.ts': 1,
      'packages/core/src/fake-engine.ts': 3,
      'packages/core/src/nodes/fields.ts': 2,
      'packages/core/src/nodes/index.ts': 1,
      'packages/core/src/receipt.ts': 1,
      'packages/core/src/run.ts': 8,
      'packages/core/src/validate.ts': 1,
      'packages/core/src/viewShape.ts': 2,
      'packages/server/src/cli.ts': 1,
      'packages/server/src/engines.ts': 1,
      'packages/server/src/loop/store.ts': 4,
      'packages/server/src/loop/types.ts': 1,
      'packages/server/src/loop/wire-util.ts': 2,
      'packages/server/src/models.ts': 3,
      'packages/server/src/mods/actions.ts': 1,
      'packages/server/src/mods/anthropic-messages/index.ts': 1,
      'packages/server/src/mods/claude-code-cli/engine.ts': 1,
      'packages/server/src/mods/claude-code-cli/index.ts': 1,
      'packages/server/src/mods/claude-code-cli/stream.ts': 3,
      'packages/server/src/mods/openai-chat/index.ts': 1,
      'packages/server/src/mods/types.ts': 1,
      'packages/server/src/run-checks.ts': 8,
      'packages/server/src/run-cli.ts': 4,
      'packages/server/src/server.ts': 6,
      'packages/server/src/session.ts': 15,
      'packages/server/src/settings.ts': 4,
      'packages/server/src/store.ts': 7,
      'packages/server/src/trust.ts': 2,
    },
  },
  run: {
    reason: "the word run: the feed piece type 'run', a `run:` thunk or tool field, the run command. Not the run block.",
    files: {
      'packages/app/src/Chat.tsx': 2,
      'packages/app/src/FeedView.tsx': 5,
      'packages/app/src/RunDock.tsx': 1,
      'packages/app/src/TextTab.tsx': 1,
      'packages/app/src/feed.ts': 3,
      'packages/server/src/cli.ts': 1,
      'packages/server/src/drive.ts': 2,
      'packages/server/src/loop/engine.ts': 7,
      'packages/server/src/loop/tools.ts': 1,
      'packages/server/src/server.ts': 1,
    },
  },
  cmd: {
    reason: "`cmd` as a parameter name (a command string), and core's COND_PARAM_KEYS list of condition parameters. Not the cmd condition.",
    files: {
      'packages/app/src/condKinds.ts': 1,
      'packages/core/src/cond.ts': 3,
      'packages/core/src/nodes/index.ts': 1,
      'packages/core/src/run.ts': 5,
      'packages/server/src/commands.ts': 1,
      'packages/server/src/doctor.ts': 1,
      'packages/server/src/opener.ts': 1,
    },
  },
  done: {
    reason: "a status word: run, step or receipt state 'done', a `done?:` flag, an API stop reason. Not the done condition.",
    files: {
      'packages/app/src/StepChips.tsx': 1,
      'packages/app/src/Workspace.tsx': 1,
      'packages/app/src/feed.ts': 8,
      'packages/app/src/history.ts': 5,
      'packages/app/src/runState.ts': 3,
      'packages/app/src/stepStatus.ts': 6,
      'packages/core/src/nodes/fields.ts': 1,
      'packages/core/src/receipt.ts': 3,
      'packages/core/src/run.ts': 4,
      'packages/core/src/viewShape.ts': 1,
      'packages/server/src/drive.ts': 2,
      'packages/server/src/live-models.ts': 1,
      'packages/server/src/loop/engine.ts': 1,
      'packages/server/src/loop/types.ts': 1,
      'packages/server/src/mods/anthropic-messages/index.ts': 1,
      'packages/server/src/mods/openai-chat/index.ts': 1,
      'packages/server/src/run-cli.ts': 3,
      'packages/server/src/server.ts': 1,
      'packages/server/src/session.ts': 1,
    },
  },
  say: {
    reason: "the `say` output callback of the CLI and doctor, the retry table's `say:` function, the chat's 'say' event and its row. Not the say block.",
    files: {
      'packages/app/src/feed.ts': 1,
      'packages/app/src/rows/say.tsx': 1,
      'packages/app/src/runState.ts': 1,
      'packages/server/src/doctor.ts': 2,
      'packages/server/src/loop/retry.ts': 12,
      'packages/server/src/session.ts': 1,
    },
  },
  phase: {
    reason: "RunPhase and the ended-phase of the app's run state (live / ended). Not the phase block.",
    files: {
      'packages/app/src/StepChips.tsx': 1,
      'packages/app/src/TextTab.tsx': 1,
      'packages/app/src/runState.ts': 2,
    },
  },
  attempts: {
    reason: "`attempts` as a count field of a step's status and the status rule key. Not the attempts condition.",
    files: {
      'packages/app/src/stepStatus.ts': 1,
      'packages/core/src/nodes/fields.ts': 1,
      'packages/core/src/viewShape.ts': 1,
    },
  },
  gate: {
    reason: "the pause and question type `gate` core raises (PauseReason, Question.kind, awaiting(track,'gate')), the 'gate' palette colour and status rule key. A pause type, not a lookup of the gate block.",
    files: {
      'packages/app/src/stepStatus.ts': 1,
      'packages/core/src/nodes/fields.ts': 2,
      'packages/core/src/run.ts': 12,
      'packages/core/src/viewShape.ts': 3,
      'packages/server/src/drive.ts': 6,
      'packages/server/src/questions/gate.ts': 1,
      'packages/server/src/run-cli.ts': 1,
      'packages/server/src/session.ts': 1,
    },
  },
  subagent: {
    reason: "JudgeKind 'subagent' (who judges a condition) and the `subagent:` service run.ts hands a block as vm.subagent. Not a lookup of the subagent block.",
    files: {
      'packages/core/src/cond.ts': 1,
      'packages/core/src/run.ts': 1,
    },
  },
  drift: {
    reason: "the workflow's `drift:` front-matter key (limits for drift detection). Not the drift condition.",
    files: {
      'packages/core/src/format/parse.ts': 1,
      'packages/core/src/model.ts': 1,
    },
  },
  repeat: {
    reason: "a `repeat` count inside the workflow's `drift:` key. Not the repeat block.",
    files: {
      'packages/core/src/model.ts': 1,
    },
  },
  verify: {
    reason: "the palette colour name `verify` of a block view (KindView.colour). Not the verify block.",
    files: {
      'packages/core/src/nodes/fields.ts': 1,
      'packages/core/src/viewShape.ts': 1,
    },
  },
  same: {
    reason: "`same` as an outcome word (SwitchOutcome 'same') and as the key that dedupes tool approvals. Not the same condition.",
    files: {
      'packages/core/src/nodes/index.ts': 1,
      'packages/server/src/loop/engine.ts': 2,
      'packages/server/src/session.ts': 1,
    },
  },
  recall: {
    reason: "the `recall` and `store` services (Knowl) core hands a block through vm.services and takes from the host, and the host's `recall` list of a track. Not a lookup of the recall block.",
    files: {
      'packages/core/src/nodes/index.ts': 1,
      'packages/core/src/run.ts': 8,
    },
  },
  store: {
    reason: "the conversation and settings store objects (`store:` options) and the Knowl `store` service. Not the store block.",
    files: {
      'packages/core/src/nodes/index.ts': 1,
      'packages/core/src/run.ts': 3,
      'packages/server/src/engines.ts': 1,
      'packages/server/src/recover.ts': 1,
      'packages/server/src/run-cli.ts': 1,
      'packages/server/src/server.ts': 4,
      'packages/server/src/session.ts': 1,
      'packages/server/src/settings.ts': 1,
      'packages/server/src/store.ts': 1,
    },
  },
  guard: {
    reason: "the reason text of a refusal that the receipt counts as a guard refusal. Not the guard card.",
    files: {
      'packages/core/src/receipt.ts': 1,
    },
  },
  approve: {
    reason: "the answer word 'approve' to a gate question, and the permission decision values of the CLI hooks. Not the approve condition.",
    files: {
      'packages/server/src/drive.ts': 3,
      'packages/server/src/loop/engine.ts': 1,
      'packages/server/src/mods/claude-code-cli/hooks.ts': 2,
      'packages/server/src/mods/claude-code-cli/mcp.ts': 2,
      'packages/server/src/questions/gate.ts': 1,
      'packages/server/src/run-cli.ts': 1,
    },
  },
  diff: {
    reason: "`git diff` argument. Not the diff condition.",
    files: {
      'packages/server/src/drive.ts': 1,
    },
  },
};

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

/** What is wrong with { name: { file: lines } } against the allowlist: uses it does not allow (or counts that differ), entries nothing uses any more, entries with no reason. */
const judge = (seen: Record<string, Record<string, number>>, allow: typeof ALLOW) => {
  const bad: string[] = [];
  for (const [name, files] of Object.entries(seen)) for (const [file, n] of Object.entries(files)) {
    const allowed = allow[name]?.files[file];
    if (allowed !== n) bad.push(`${name} in ${file}: ${n} line(s), ${allowed === undefined ? 'not allowed' : `${allowed} allowed`}`);
  }
  const stale = Object.entries(allow).flatMap(([name, a]) => Object.keys(a.files).filter((file) => seen[name]?.[file] === undefined).map((file) => `${name} in ${file}`));
  const noReason = Object.entries(allow).filter(([, a]) => a.reason.length < 20).map(([name]) => name);
  return { bad, stale, noReason };
};

/** Every file of the three packages' `src`, as { rel, text } with the line ends made plain. */
const sources = () => readdirSync(join(root, 'packages')).flatMap((p) => existsSync(join(root, 'packages', p, 'src')) ? walk(join(root, 'packages', p, 'src')) : [])
  .map((f) => ({ rel: relative(root, f).replace(/\\/g, '/'), text: readFileSync(f, 'utf8').replace(/\r/g, '') }));

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
    ];
    for (const p of planted) expect(hit(p), p).toBe(true);
  });

  it('the matcher is quiet on longer text, comments, other names and words that only contain a name', () => {
    const quiet = [
      "const t = 'the end of the line';", "say('run the tests');", '// the "end" block', ' * a `gate` card', '/* if */', "const x = 'ending';", "const y = 'subagents';",
      'const ended = true;', 'const store: Map<string, number> = new Map();', 'f(end)', 'const run = 1;', "const z = 'done_by';", 'let a = b ? end : now;', 'x = y // the "end"',
    ];
    for (const q of quiet) expect(hit(q), q).toBe(false);
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

  it('no file names a pack kind, condition, card, op or event, and the allowlist is exact', () => {
    const seen: Record<string, Record<string, number>> = {};
    for (const { rel, text } of sources()) for (const h of hitsIn(text, rel)) { const f = (seen[h.name] ??= {}); f[rel] = (f[rel] ?? 0) + 1; }
    expect(judge(seen, ALLOW)).toEqual({ bad: [], stale: [], noReason: [] });
  });

  it('the allowlist is exact: a new use, a changed count, a removed use and a missing reason are all found', () => {
    const allow = { end: { reason: 'a range end, not the end block', files: { 'a.ts': 2 } }, run: { reason: 'short', files: { 'b.ts': 1 } } };
    expect(judge({ end: { 'a.ts': 2 }, run: { 'b.ts': 1 } }, allow)).toEqual({ bad: [], stale: [], noReason: ['run'] });
    expect(judge({ end: { 'a.ts': 3 }, run: { 'b.ts': 1 } }, allow).bad).toEqual(['end in a.ts: 3 line(s), 2 allowed']);
    expect(judge({ end: { 'a.ts': 1 }, run: { 'b.ts': 1 } }, allow).bad).toEqual(['end in a.ts: 1 line(s), 2 allowed']);
    expect(judge({ end: { 'a.ts': 2, 'c.ts': 1 }, run: { 'b.ts': 1 } }, allow).bad).toEqual(['end in c.ts: 1 line(s), not allowed']);
    expect(judge({ gate: { 'a.ts': 1 }, end: { 'a.ts': 2 }, run: { 'b.ts': 1 } }, allow).bad).toEqual(['gate in a.ts: 1 line(s), not allowed']);
    expect(judge({ end: { 'a.ts': 2 } }, allow).stale).toEqual(['run in b.ts']);
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
