// M2 Task 18: the question cards, the condition menu and the card words moved from code in the app to data from the server. The file
// fixtures/head-questions.json was RECORDED FROM HEAD 2b011c3 (the eight files under src/questions, COND_KINDS, CARD_LABEL) before any of it moved:
// each button's label, primary flag, field and the answer it built for 18 typed texts. Nothing here is edited to fit the new code.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COND_VIEWS, freshCond } from '../src/condKinds.js';
import { CARD_KINDS, CARD_LABEL } from '../src/canvasKinds.js';
import { actionsFor, detailFor, GENERIC, offersStop } from '../src/questions.js';

type Rec = { detail: string | null; actions: Array<{ label: string; primary: boolean; field: Record<string, string> | null; answers: Array<string | null> }> };
const head = JSON.parse(fs.readFileSync(new URL('./fixtures/head-questions.json', import.meta.url), 'utf8')) as {
  INPUTS: string[]; conds: Array<{ t: string; label: string; fresh: object; param: object | null }>; cards: Record<string, object>;
} & Record<string, Rec>;
const KINDS = ['gate', 'budget', 'resume', 'usd', 'tool', 'judge', 'trust', 'switch'];
const pick = (kind: string, label: string) => actionsFor(kind).find((a) => a.label === label)!;

describe('the eight question cards equal what HEAD built', () => {
  it.each(KINDS)('%s: buttons, order, primary, field, detail and every answer', (kind) => {
    const want = head[kind]!;
    const got = actionsFor(kind);
    expect(got.map((a) => a.label)).toEqual(want.actions.map((a) => a.label));
    for (const [i, a] of want.actions.entries()) {
      expect(!!got[i]!.primary, `${kind}/${a.label} primary`).toBe(a.primary);
      expect(got[i]!.field ?? null, `${kind}/${a.label} field`).toEqual(a.field);
      expect(head.INPUTS.map((t) => got[i]!.build(t)), `${kind}/${a.label} answers`).toEqual(a.answers);
    }
    expect(detailFor(kind) ?? null).toBe(want.detail);
  });

  it('a kind the list does not hold gets the generic card, as recorded', () => {
    expect(actionsFor('nope')).toBe(GENERIC.actions);
    expect(head.nope!.actions.map((a) => a.label)).toEqual(['Send']);
    expect(head.INPUTS.map((t) => actionsFor('nope')[0]!.build(t))).toEqual(head.nope!.actions[0]!.answers);
  });

  it('the gate card sends approve, changes <note> and stop', () => {
    expect(pick('gate', 'Approve').build('')).toBe('approve');
    expect(pick('gate', 'Request changes').build('  rename it ')).toBe('changes rename it');
    expect(pick('gate', 'Request changes').build('  ')).toBeNull();
    expect(pick('gate', 'Stop').build('')).toBe('stop');
  });

  it('the money card: Allow with x sends nothing, with 0.5 sends allow $0.5 (as HEAD did); the turns card refuses 0.5', () => {
    const usd = pick('usd', 'Allow');
    expect(usd.build('x')).toBeNull();
    expect(usd.build('0.5')).toBe('allow $0.5');
    expect(usd.build('1.234')).toBeNull();
    expect(usd.build('0')).toBeNull();
    const turns = pick('budget', 'Allow');
    expect(turns.build('x')).toBeNull();
    expect(turns.build('0.5')).toBeNull();
    expect(turns.build('007')).toBe('allow 7');
  });

  it('a pattern in the typed text is sent as typed ($& and $1 are not read)', () => {
    expect(pick('gate', 'Request changes').build('a $& b $1 $$')).toBe('changes a $& b $1 $$');
    expect(pick('tool', 'Deny').build("$' x")).toBe("n $' x");
  });

  it('offersStop is what it was', () => {
    for (const k of ['gate', 'budget', 'resume', 'usd']) expect(offersStop(k), k).toBe(true);
    for (const k of ['tool', 'trust', 'judge', 'switch', 'nope']) expect(offersStop(k), k).toBe(false);
  });
});

describe('the condition menu and the card words equal what HEAD held', () => {
  it('the 11 atoms: order, labels, new atom and box', () => {
    expect(Object.values(COND_VIEWS).map((c) => ({ t: c.t, label: c.label, fresh: c.fresh, param: c.param ?? null }))).toEqual(head.conds);
    expect(head.conds).toHaveLength(11);
  });

  it('a new atom is a copy each time and equals the recorded one', () => {
    for (const c of head.conds) {
      expect(freshCond(c.t)).toEqual(c.fresh);
      expect(freshCond(c.t)).not.toBe(freshCond(c.t));
    }
  });

  it('the guard card words', () => {
    expect(CARD_KINDS).toEqual(['guard']);
    expect({ ...CARD_LABEL }).toEqual(head.cards);
  });
});
