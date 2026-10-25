// M2 Task 18: the eight question cards are core's data (src/questions), served and not reachable by a mod; the editor data of the conditions and cards
// (CondType.view, CardType.view) is served; a condition mod's view is checked when it loads (param.key is one of cmd, q, n, glob). Mods here are made
// at run time in a temp home through `tempHome`.
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CARDS, CONDS, hasHiddenChars, registerCard, registerCondition, Registry } from '@reins/core';
import { BUNDLED_MODS } from '../src/engines.js';
import { loadMods } from '../src/mods/loader.js';
import type { LoadedMod, Mods } from '../src/mods/types.js';
import { servedKinds } from '../src/mods/kinds-view.js';
import { QUESTIONS, questionRefusal } from '../src/questions/index.js';
import { boot, cleanup } from './http-helpers.js';
import { tempHome } from './mods-harness.js';

// What the eight files under packages/app/src/questions held at HEAD 2b011c3, as data: the app's pin (app/test/questionsPin.test.ts) checks the answers.
const WANT = [
  { kind: 'budget', actions: [{ label: 'Allow', primary: true, answer: 'allow {text}', field: { placeholder: 'more turns', initial: '2', check: 'count' } }, { label: 'Stop', answer: 'stop' }] },
  { kind: 'gate', actions: [{ label: 'Approve', primary: true, answer: 'approve' }, { label: 'Request changes', answer: 'changes {text}', field: { placeholder: 'what to change' } }, { label: 'Stop', answer: 'stop' }] },
  { kind: 'judge', actions: [{ label: 'Yes', primary: true, answer: 'y' }, { label: 'No', answer: 'n' }] },
  { kind: 'resume', actions: [{ label: 'Resume', primary: true, answer: 'resume {text}', field: { placeholder: 'note (optional)', empty: 'resume' } }, { label: 'Stop', answer: 'stop' }] },
  { kind: 'switch', actions: [{ label: 'Switch', primary: true, answer: 'switch' }, { label: 'Keep the current model', answer: 'keep' }] },
  { kind: 'tool', detail: 'json', actions: [{ label: 'Allow', primary: true, answer: 'y' }, { label: 'Deny', answer: 'n {text}', field: { placeholder: 'reason (optional)', empty: 'n' } }] },
  { kind: 'trust', actions: [{ label: 'Trust', primary: true, answer: 'y' }, { label: "Don't trust", answer: 'n' }] },
  { kind: 'usd', actions: [{ label: 'Allow', primary: true, answer: 'allow ${text}', field: { placeholder: 'more USD', initial: '0.50', check: 'usd' } }, { label: 'Stop', answer: 'stop' }] },
];
const COND_ORDER = ['approve', 'tests', 'cmd', 'llm', 'review', 'done', 'diff', 'touches', 'attempts', 'same', 'drift'];
const RLO = '\u202e';

let h: ReturnType<typeof tempHome>;
const loaded: Mods[] = [];
beforeEach(() => { h = tempHome(); });
afterEach(async () => {
  for (const m of loaded.splice(0).reverse()) m.dispose();
  await cleanup();
  h.cleanup();
});

const load = async (trusted = true) => {
  const m = await loadMods({ bundledDir: path.join(h.home, 'no-bundled'), userDir: h.modsDir, home: h.home, disabled: new Set(), trusted: () => trusted, env: {} });
  loaded.push(m);
  return m;
};
/** The same load with the bundled folder the product ships: the default pack's conditions and cards (M3 Task 8) are in core, with their editor data from their manifests. */
const loadReal = async (trusted = true) => {
  const m = await loadMods({ bundledDir: BUNDLED_MODS, userDir: h.modsDir, home: h.home, disabled: new Set(), trusted: () => trusted, env: {} });
  loaded.push(m);
  return m;
};
const find = (m: Mods, id: string) => m.mods.find((x) => x.id === id) as LoadedMod;
const code = (body: string) => `export default function activate(api) { ${body} }\n`;
const atom = (t: string, extra = '') => `{ t: '${t}', parse(s) { if (!s.src.startsWith('${t}', s.idx)) return null; s.idx += ${t.length}; return { t: '${t}' }; }, print: () => '${t}', judge: 'agent', evalSync: () => true${extra} }`;
const condMod = (id: string, over: Record<string, unknown> = {}) => ({ reins: 1, id, kind: 'condition', version: '1.0.0', label: id, main: 'index.js', order: 500, provides: { conditions: ['ping'] }, view: { ping: { label: 'pings', fresh: { t: 'ping' } } }, ...over });
const cardMod = (id: string, over: Record<string, unknown> = {}) => ({ reins: 1, id, kind: 'card', version: '1.0.0', label: id, main: 'index.js', order: 500, provides: { cards: ['zap'] }, view: { zap: { section: 'Zaps', add: 'Add zap' } }, ...over });
const coreNow = () => JSON.stringify({ c: [...CONDS.keys()], k: [...CARDS.keys()] });

describe('the eight question cards are core data', () => {
  it('there are eight, in the order the app listed them, and each is the data HEAD held', () => {
    expect(QUESTIONS.map((q) => q.kind)).toEqual(['budget', 'gate', 'judge', 'resume', 'switch', 'tool', 'trust', 'usd']);
    expect(QUESTIONS).toEqual(WANT);
  });

  it('each card is plain data: no function, and every text passes the hidden-character check', () => {
    const walk = (v: unknown): void => {
      expect(typeof v).not.toBe('function');
      if (typeof v === 'string') expect(hasHiddenChars(v), v).toBe(false);
      else if (typeof v === 'object' && v !== null) Object.values(v).forEach(walk);
    };
    walk(QUESTIONS);
  });

  it('the list is frozen all the way down: nothing can be added, replaced or edited', () => {
    expect(Object.isFrozen(QUESTIONS)).toBe(true);
    for (const q of QUESTIONS) {
      expect(Object.isFrozen(q), q.kind).toBe(true);
      expect(Object.isFrozen(q.actions), q.kind).toBe(true);
      for (const a of q.actions) {
        expect(Object.isFrozen(a), a.label).toBe(true);
        if (a.field) expect(Object.isFrozen(a.field), a.label).toBe(true);
      }
    }
    expect(() => (QUESTIONS as unknown as unknown[]).push({ kind: 'x', actions: [] })).toThrow(TypeError);
    expect(() => { (QUESTIONS[1] as { kind: string }).kind = 'mine'; }).toThrow(TypeError);
    expect(() => { (QUESTIONS[1]!.actions[0] as { answer: string }).answer = 'stop'; }).toThrow(TypeError);
  });

  it('the route serves them, equal to the data, with no problem', async () => {
    const w = await boot();
    const r = await w.api('GET', '/api/kinds');
    expect(r.json.questions).toEqual(WANT);
    expect(r.json.problems).toEqual([]);
    expect(servedKinds().questions).toEqual(WANT);
  });

  it('a served copy is its own: editing it does not touch the data', () => {
    const a = servedKinds();
    a.questions[1]!.actions[0]!.answer = 'stop';
    a.questions.pop();
    expect(servedKinds().questions).toEqual(WANT);
    expect(QUESTIONS).toEqual(WANT);
  });

  it('a registry entry named like a question changes nothing that is served', () => {
    const registry = new Registry();
    registry.register('question', 'gate', { kind: 'gate', actions: [{ label: 'Pwn', answer: 'y' }] });
    registry.register('question-view', 'gate', { kind: 'gate', actions: [] });
    expect(servedKinds({ registry, mods: [] } as never).questions).toEqual(WANT);
  });
});

describe('no mod can load a question card', () => {
  it('questionRefusal: a question name in kinds (unless it is a built-in mod\'s: the pack\'s gate block), conditions or cards; nothing else', () => {
    for (const q of ['budget', 'usd', 'tool', 'trust', 'judge', 'resume', 'switch']) {
      for (const key of ['kinds', 'conditions', 'cards']) expect(questionRefusal(key, q), `${key} ${q}`).toContain('is a question card');
    }
    expect(questionRefusal('cards', 'gate')).toContain('is a question card');
    expect(questionRefusal('conditions', 'gate')).toContain('is a question card');
    expect(questionRefusal('kinds', 'gate', true)).toBeUndefined(); // the gate BLOCK is the default pack's kind; the rules for blocks apply
    expect(questionRefusal('kinds', 'gate')).toContain('is a question card'); // a mod of the user's cannot bring it (M3 Task 4)
    for (const key of ['attrs', 'ops', 'events']) expect(questionRefusal(key, 'budget'), key).toBeUndefined();
    for (const n of ['guard', 'ping', '', 'Budget', 'constructor']) expect(questionRefusal('cards', n), n).toBeUndefined();
    for (const n of [undefined, null, 3, {}, ['usd']]) expect(questionRefusal('cards', n), String(n)).toBeUndefined();
  });

  it.each([
    ['a condition mod', 'condition', 'conditions'],
    ['a card mod', 'card', 'cards'],
  ])('%s that provides a question card is refused with words, and nothing is registered', async (_w, kind, key) => {
    const before = coreNow();
    for (const q of ['usd', 'budget', 'gate']) {
      h.writeMod(`bad-${q}`, { reins: 1, id: `bad-${q}`, kind, version: '1.0.0', label: 'bad', main: 'index.js', order: 500, provides: { [key]: [q] } }, { 'index.js': code('') });
    }
    const mods = await load();
    for (const q of ['usd', 'budget', 'gate']) {
      expect(find(mods, `bad-${q}`).problems, q).toEqual([`\`bad-${q}\`: \`provides.${key}\` names \`${q}\`, which is a question card. Question cards belong to Reins: a mod cannot add, replace or change one.`]);
    }
    expect(coreNow()).toBe(before);
  });

  it('a block mod that provides a question as a kind is refused; a user mod that provides the gate block is refused too (the gate block is the default pack\'s)', async () => {
    const block = (id: string, k: string) => ({ reins: 1, id, kind: 'block', version: '1.0.0', label: id, main: 'index.js', order: 500, provides: { kinds: [k] }, view: { kind: k, fields: [], line: [k] } });
    h.writeMod('bad-trust', block('bad-trust', 'trust'), { 'index.js': code('') });
    h.writeMod('shadow-gate', block('shadow-gate', 'gate'), { 'index.js': code('') });
    const mods = await load();
    expect(find(mods, 'bad-trust').problems.join()).toContain('which is a question card');
    expect(find(mods, 'shadow-gate').problems.join()).toContain('which is a question card');
  });

  it('a mod of kind `question` is not a kind of mod', async () => {
    h.writeMod('q', { reins: 1, id: 'q', kind: 'question', version: '1.0.0', label: 'q', main: 'index.js', provides: { questions: ['gate'] } }, { 'index.js': code('') });
    const before = servedKinds().questions;
    const mods = await load();
    expect(find(mods, 'q').problems.length).toBeGreaterThan(0);
    expect(servedKinds(mods).questions).toEqual(before);
    expect(servedKinds(mods).questions).toEqual(WANT);
  });

  it('an api call that names a question card is refused and registers nothing', async () => {
    h.writeMod('zap', cardMod('zap'), { 'index.js': code("api.registerCard({ kind: 'usd', delivery: 'now' });") });
    h.writeMod('ping', condMod('ping'), { 'index.js': code(`api.registerCondition(${atom('budget')});`) });
    const before = coreNow();
    const mods = await load();
    expect(find(mods, 'zap').problems).toEqual(['`zap`: `provides.cards` does not list the card "usd".']);
    expect(find(mods, 'ping').problems).toEqual(['`ping`: `provides.conditions` does not list the condition "budget".']);
    expect(coreNow()).toBe(before);
    expect(servedKinds(mods).questions).toEqual(WANT);
  });
});

describe('a condition mod\'s view is checked when it loads', () => {
  // Ends the mods and the home of this step, and starts a new home for the next.
  const next = () => { for (const m of loaded.splice(0).reverse()) m.dispose(); h.cleanup(); h = tempHome(); };
  const bad = async (view: unknown, over: Record<string, unknown> = {}) => {
    h.writeMod('ping', condMod('ping', { view, ...over }), { 'index.js': code(`api.registerCondition(${atom('ping')});`) });
    const before = coreNow();
    const mods = await load();
    expect(coreNow(), 'nothing registered').toBe(before);
    return find(mods, 'ping').problems;
  };

  it('param.key x is refused with the four names; cmd, q, n and glob are accepted', async () => {
    const p = await bad({ ping: { label: 'x', fresh: { t: 'ping' }, param: { key: 'x', look: 'str' } } });
    expect(p).toEqual(['`ping`: `view.ping` has `param.key` "x". It must be one of cmd, q, n, glob.']);
    next();
    for (const key of ['cmd', 'q', 'n', 'glob']) {
      h.writeMod('ping', condMod('ping', { view: { ping: { label: 'x', fresh: { t: 'ping' }, param: { key, look: 'str' } } } }), { 'index.js': code(`api.registerCondition(${atom('ping')});`) });
      const mods = await load();
      expect(find(mods, 'ping').problems, key).toEqual([]);
      expect(servedKinds(mods).conds.find((c) => c.t === 'ping')?.param?.key, key).toBe(key);
      next();
    }
  });

  it.each([
    ['a param key that is a name of Object', { ping: { label: 'x', fresh: { t: 'ping' }, param: { key: 'constructor', look: 'str' } } }, 'param.key'],
    ['a param key that is not text', { ping: { label: 'x', fresh: { t: 'ping' }, param: { key: 3, look: 'str' } } }, 'param.key'],
    ['a param look that is not one of the four', { ping: { label: 'x', fresh: { t: 'ping' }, param: { key: 'q', look: 'big' } } }, 'param.look'],
    ['an optional that is not true', { ping: { label: 'x', fresh: { t: 'ping' }, param: { key: 'q', look: 'str', optional: false } } }, 'param.optional'],
    ['a param with another field', { ping: { label: 'x', fresh: { t: 'ping' }, param: { key: 'q', look: 'str', run: 'x' } } }, 'not { key, look, optional }'],
    ['a param that is a list', { ping: { label: 'x', fresh: { t: 'ping' }, param: ['q'] } }, 'not { key, look, optional }'],
    ['another field in the entry', { ping: { label: 'x', fresh: { t: 'ping' }, default: 'x' } }, 'not part of a condition\'s view'],
    ['no label', { ping: { fresh: { t: 'ping' } } }, 'needs a `label`'],
    ['a label that is too long', { ping: { label: 'x'.repeat(61), fresh: { t: 'ping' } } }, 'needs a `label`'],
    ['a fresh atom of another t', { ping: { label: 'x', fresh: { t: 'pong' } } }, 'needs a `fresh` atom'],
    ['a fresh atom that holds an object', { ping: { label: 'x', fresh: { t: 'ping', q: { a: 1 } } } }, 'needs a `fresh` atom'],
    ['a fresh atom that holds a list', { ping: { label: 'x', fresh: { t: 'ping', q: [1] } } }, 'needs a `fresh` atom'],
    ['a name that is not provided', { pong: { label: 'x', fresh: { t: 'pong' } } }, 'is not in `provides.conditions`'],
    ['an entry that is not an object', { ping: 'x' }, 'must be an object'],
    ['a view that is a list', [{ label: 'x' }], 'must be an object with one entry'],
  ])('%s is refused', async (_w, view, words) => {
    const p = await bad(view);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('`ping`: ');
    expect(p[0]).toContain(words);
  });

  it('a hidden character in the label, in a fresh value or in a key is refused', async () => {
    for (const view of [
      { ping: { label: `a${RLO}b`, fresh: { t: 'ping' } } },
      { ping: { label: 'x', fresh: { t: 'ping', q: `a\nb` } } },
      { ping: { label: 'x', fresh: { t: 'ping', [`k${RLO}`]: 'v' } } },
    ]) {
      const p = await bad(view);
      expect(p, JSON.stringify(view)).toHaveLength(1);
      expect(p[0]).toContain('control, line-break or direction-changing character');
      next();
    }
  });

  it('a view larger than 32 KB is refused', async () => {
    const p = await bad({ ping: { label: 'x', fresh: { t: 'ping', q: 'x'.repeat(33 * 1024) } } });
    expect(p[0]).toContain('larger than 32 KB');
  });

  it('a condition mod with no view is fine (it is just not offered in the editor)', async () => {
    h.writeMod('ping', condMod('ping', { view: undefined }), { 'index.js': code(`api.registerCondition(${atom('ping')});`) });
    const mods = await load();
    expect(find(mods, 'ping').problems).toEqual([]);
    expect(CONDS.has('ping')).toBe(true);
    expect(servedKinds(mods).conds.map((c) => c.t)).not.toContain('ping');
  });

  it('a second mod that names a taken condition fails whole: its other views are not left behind', async () => {
    h.writeMod('a-ping', condMod('a-ping'), { 'index.js': code(`api.registerCondition(${atom('ping')});`) });
    h.writeMod('b-pong', condMod('b-pong', { provides: { conditions: ['pong', 'ping'] }, view: { pong: { label: 'pongs', fresh: { t: 'pong' } }, ping: { label: 'again', fresh: { t: 'ping' } } } }), { 'index.js': code(`api.registerCondition(${atom('pong')});`) });
    const mods = await load();
    expect(find(mods, 'a-ping').problems).toEqual([]);
    expect(find(mods, 'b-pong').problems.length).toBeGreaterThan(0);
    expect(mods.registry.has('cond-view', 'pong')).toBe(false);
    expect(CONDS.has('pong')).toBe(false);
    expect(servedKinds(mods).conds.find((c) => c.t === 'ping')?.label).toBe('pings');
  });
  it('a card view with another field, or a missing word, is refused', async () => {
    h.writeMod('zap', cardMod('zap', { view: { zap: { section: 'Z', add: 'A', run: 'x' } } }), { 'index.js': code("api.registerCard({ kind: 'zap' });") });
    h.writeMod('zip', cardMod('zip', { provides: { cards: ['zip'] }, view: { zip: { section: 'Z' } } }), { 'index.js': code("api.registerCard({ kind: 'zip' });") });
    const mods = await load();
    expect(find(mods, 'zap').problems[0]).toContain('not part of a card\'s view');
    expect(find(mods, 'zip').problems[0]).toContain('needs a `section` and an `add`');
    expect(CARDS.has('zap')).toBe(false);
  });
});

describe('the served conditions and cards', () => {
  it('the pack\'s conditions come with their views (the manifests\'), in core\'s order; core alone offers none', async () => {
    expect(servedKinds().conds).toEqual([]);
    const mods = await loadReal();
    const s = servedKinds(mods);
    expect(s.conds.map((c) => c.t)).toEqual(COND_ORDER);
    expect(s.conds.map((c) => c.t)).toEqual([...CONDS.keys()]);
    for (const c of s.conds) {
      const { t, ...view } = c;
      expect(view, t).toEqual(JSON.parse(JSON.stringify(mods.registry.get('cond-view', t))));
    }
    expect(s.conds.find((c) => c.t === 'cmd')).toEqual({ t: 'cmd', label: 'command passes', fresh: { t: 'cmd', cmd: 'npm run lint' }, param: { key: 'cmd', look: 'code' } });
    expect(s.conds.find((c) => c.t === 'review')?.param).toEqual({ key: 'q', look: 'str', optional: true });
    expect(s.conds.find((c) => c.t === 'approve')).toEqual({ t: 'approve', label: 'you approve', fresh: { t: 'approve' } });
    expect(s.cards).toEqual([{ kind: 'guard', section: 'Guards', add: 'Add guard' }]);
    expect(s.problems).toEqual([]);
  });

  it('every pack param key is one of the four', async () => {
    for (const c of servedKinds(await loadReal()).conds) if (c.param) expect(['cmd', 'q', 'n', 'glob'], c.t).toContain(c.param.key);
  });

  it('the route carries them', async () => {
    const w = await boot();
    const r = await w.api('GET', '/api/kinds');
    expect(r.json.conds.map((c: { t: string }) => c.t)).toEqual(COND_ORDER);
    expect(r.json.cards).toEqual([{ kind: 'guard', section: 'Guards', add: 'Add guard' }]);
  });

  it('a condition mod\'s view is served at the place the condition has in core; its code cannot hand over a view', async () => {
    h.writeMod('ping', condMod('ping', { order: 25 }), { 'index.js': code(`api.registerCondition(${atom('ping', ", view: { label: 'EVIL', fresh: { t: 'ping' } }")});`) });
    const mods = await loadReal();
    expect(find(mods, 'ping').problems).toEqual([]);
    const s = servedKinds(mods);
    expect(s.conds.map((c) => c.t)).toEqual([...COND_ORDER.slice(0, 2), 'ping', ...COND_ORDER.slice(2)]);
    expect(s.conds[2]).toEqual({ t: 'ping', label: 'pings', fresh: { t: 'ping' } });
    expect(CONDS.get('ping')!.view).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain('EVIL');
    mods.dispose();
    expect(servedKinds(mods).conds.map((c) => c.t)).toEqual([]); // the pack's atoms go with the load, as the mod's own
    expect(mods.registry.has('cond-view', 'ping')).toBe(false); // the view goes with the mod
  });

  it('a condition or card mod whose code is not trusted is not in core, so not offered', async () => {
    h.writeMod('ping', condMod('ping'), { 'index.js': code(`api.registerCondition(${atom('ping')});`) });
    h.writeMod('zap', cardMod('zap'), { 'index.js': code("api.registerCard({ kind: 'zap' });") });
    const mods = await loadReal(false);
    expect(find(mods, 'ping').problems.join()).toContain('needs trust');
    const s = servedKinds(mods);
    expect(s.conds.map((c) => c.t)).toEqual(COND_ORDER);
    expect(s.cards.map((c) => c.kind)).toEqual(['guard']);
  });

  it('a card mod\'s words are served, after the built-in guard; its code cannot hand over a view', async () => {
    h.writeMod('zap', cardMod('zap'), { 'index.js': code("api.registerCard({ kind: 'zap', view: { section: 'EVIL', add: 'EVIL' } });") });
    const mods = await loadReal();
    expect(find(mods, 'zap').problems).toEqual([]);
    expect(servedKinds(mods).cards).toEqual([{ kind: 'guard', section: 'Guards', add: 'Add guard' }, { kind: 'zap', section: 'Zaps', add: 'Add zap' }]);
    expect(JSON.stringify(servedKinds(mods))).not.toContain('EVIL');
    expect(CARDS.get('zap')!.view).toBeUndefined();
    mods.dispose();
    expect(mods.registry.has('card-view', 'zap')).toBe(false);
  });

  it('a card with no view (now, stop) is not offered', async () => {
    const mods = await loadReal();
    expect([...CARDS.keys()]).toEqual(['guard', 'now', 'stop']);
    expect(servedKinds(mods).cards.map((c) => c.kind)).toEqual(['guard']);
  });

  // Task 25a (MINOR 2), after M3 Task 8: the pack's data for a pack atom or card is the one its manifest recorded; a view recorded under that name
  // by anyone else is refused by the registry (the name is taken), so it is never served. (At HEAD core held the data; now the pack's mod does.)
  it('a view recorded under a pack atom\'s or card\'s name by anyone else is refused, and the pack\'s data is served', async () => {
    const mods = await loadReal();
    expect(() => mods.registry.register('cond-view', 'cmd', { label: 'Mine', fresh: { t: 'cmd', cmd: 'x' } })).toThrow(/already registered/);
    expect(() => mods.registry.register('card-view', 'guard', { section: 'Mine', add: 'Mine' })).toThrow(/already registered/);
    const s = servedKinds(mods);
    expect(s.conds.find((c) => c.t === 'cmd')?.label).toBe('command passes');
    expect(s.conds.find((c) => c.t === 'tests')?.label).toBe('tests pass');
    expect(s.conds.map((c) => c.t)).toEqual(COND_ORDER);
    expect(s.cards).toEqual([{ kind: 'guard', section: 'Guards', add: 'Add guard' }]);
  });

  it('the served t is the atom\'s own, whatever the view says', async () => {
    const mods = await loadReal();
    expect(servedKinds(mods).conds.filter((c) => c.t === 'tests')).toHaveLength(1);
    const copy = new Registry();
    copy.register('cond-view', 'cmd', { t: 'tests', label: 'Mine', fresh: { t: 'cmd' } });
    const s = servedKinds({ registry: copy, mods: [] } as never);
    expect(s.conds.filter((c) => c.t === 'tests')).toHaveLength(0);
    expect(s.conds.find((c) => c.t === 'cmd')).toEqual({ t: 'cmd', label: 'Mine', fresh: { t: 'cmd' } });
  });

  // These three used core names (cmd, guard, llm); a core name now serves the built-in's data, so they use atoms and cards a mod registered (Task 25a, MINOR 2).
  const withMod = (conds: string[], cards: string[], run: () => void) => {
    const off = [...conds.map((t) => registerCondition({ t } as never)), ...cards.map((kind) => registerCard({ kind } as never))];
    try { run(); } finally { off.forEach((f) => f()); }
  };

  it('a label with a hidden character is not served, and the problem says so in \\u form', () => withMod(['zed'], ['zip'], () => {
    const registry = new Registry();
    registry.register('cond-view', 'zed', { label: `a${RLO}b`, fresh: { t: 'zed' } });
    registry.register('card-view', 'zip', { section: 'Guards', add: `Add\u0000guard` });
    const s = servedKinds({ registry, mods: [] } as never);
    expect(s.conds.map((c) => c.t)).not.toContain('zed');
    expect(s.cards.map((c) => c.kind)).not.toContain('zip');
    expect(s.problems).toHaveLength(2);
    expect(s.problems.join('\n')).toContain('condition zed');
    expect(s.problems.join('\n')).toContain('card zip');
    const wire = JSON.stringify(s);
    expect(wire).not.toContain(RLO);
    expect(wire).not.toContain('\\u0000');
    expect(s.problems.some(hasHiddenChars)).toBe(false);
  }));

  it('a hidden character in a key of a view is not served either', () => withMod(['zed'], [], () => {
    const registry = new Registry();
    registry.register('cond-view', 'zed', { label: 'x', fresh: { t: 'zed', [`k${RLO}`]: 'v' } });
    expect(servedKinds({ registry, mods: [] } as never).conds.map((c) => c.t)).not.toContain('zed');
  }));

  it('a view that is not JSON (a function, a throwing getter) is left out or comes without the function', () => withMod(['zed', 'zid'], [], () => {
    const registry = new Registry();
    registry.register('cond-view', 'zed', { label: 'x', fresh: { t: 'zed' }, run: () => 1 });
    registry.register('cond-view', 'zid', { get label(): string { throw new Error('no'); }, fresh: { t: 'zid' } });
    const s = servedKinds({ registry, mods: [] } as never);
    expect(s.conds.find((c) => c.t === 'zed')).toEqual({ t: 'zed', label: 'x', fresh: { t: 'zed' } });
    expect(s.conds.map((c) => c.t)).not.toContain('zid');
    expect(s.problems.join()).toContain('could not be read as JSON');
  }));
});
