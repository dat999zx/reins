// The tag builder and the /api/tags catalogue (plan 15d 3b.5, 3b.8 unit tests).
import { describe, it, expect } from 'vitest';
import { CARDS } from '@reins/core';
import { buildTagged, tagCatalogue, taggedWorkflow, type Tag } from '../src/tags.js';

const t = (tag: string, arg?: string): Tag => ({ tag, ...(arg !== undefined ? { arg } : {}) });
const head = ['---', 'reins: 1', 'name: chat', 'always: []', 'budget: { turns: 20, minutes: 30 }', '---', ''];
const built = (text: string, ...tags: Tag[]): string => {
  const b = buildTagged(text, tags);
  if (!b.ok) throw new Error(b.error);
  return b.text;
};
const refusal = (text: string, ...tags: Tag[]): string => {
  const b = buildTagged(text, tags);
  return b.ok ? '' : b.error;
};

describe('buildTagged (3b.5)', () => {
  it('no tags: one phase step whose prompt lines all start with "> "', () => {
    expect(built('hello\nworld')).toBe([...head, '## phase prompt', '> hello', '> world', ''].join('\n'));
  });

  it('a card tag becomes that card line on the prompt step, before the prompt', () => {
    expect(built('go', t('guard', 'migrations/**'))).toBe([...head, '## phase prompt', 'guard: migrations/**', '> go', ''].join('\n'));
  });

  it('an attribute tag becomes an attribute line, and #read-only is #mode read-only', () => {
    const a = built('go', t('mode', 'read-only'));
    expect(a).toBe([...head, '## phase prompt', 'mode: read-only', '> go', ''].join('\n'));
    expect(built('go', t('read-only'))).toBe(a);
  });

  it('after tags become top-level steps after the prompt, in the order typed', () => {
    expect(built('go', t('gate'), t('verify'))).toBe(
      [...head, '## phase prompt', '> go', '', '## gate', 'until: you approve', '', '## verify', 'against: prompt', ''].join('\n'));
    const rev = built('go', t('verify'), t('gate'));
    expect(rev.indexOf('## verify')).toBeLessThan(rev.indexOf('## gate'));
  });

  it('a wrap tag becomes a container around the prompt step, with its argument and its fixed lines', () => {
    expect(built('go', t('repeat', 'tests pass'))).toBe(
      [...head, '## repeat', 'until: tests pass', 'max: 5', '', '### phase prompt', '> go', ''].join('\n'));
  });

  it('wraps nest with the last typed outermost, and after steps stay at the top level after them', () => {
    expect(built('go', t('repeat', 'a'), t('repeat', 'b'), t('gate'))).toBe([...head,
      '## repeat', 'until: b', 'max: 5', '',
      '### repeat', 'until: a', 'max: 5', '',
      '#### phase prompt', '> go', '',
      '## gate', 'until: you approve', ''].join('\n'));
  });

  it('four nested wraps are fine (the prompt is at ######), five are refused', () => {
    const four = Array.from({ length: 4 }, () => t('repeat', 'tests pass'));
    expect(built('go', ...four)).toContain('###### phase prompt');
    expect(refusal('go', ...four, t('repeat', 'tests pass'))).toMatch(/at most 4/);
  });

  it('an argument with a line break is refused, and a prompt with line breaks is not', () => {
    expect(refusal('go', t('guard', 'a\nb'))).toMatch(/one line/);
    expect(refusal('go', t('repeat', 'x\r'))).toMatch(/one line/);
    expect(built('a\r\nb\n\nc')).toContain('> a\n> b\n> \n> c');
  });

  it('every bad tag is refused with a reason', () => {
    const cases: Array<[string, Tag, RegExp]> = [
      ['an attribute the phase does not have', t('max', '3'), /unknown tag "max"/],
      ['a link kind', t('on-fail', 'x'), /unknown tag "on-fail"/],
      ['a name nobody knows', t('nope'), /unknown tag "nope"/],
      ['a delivery card (now is only for whenever)', t('now', 'x'), /unknown tag "now"/],
      ['a delivery card (stop)', t('stop', 'x'), /unknown tag "stop"/],
      ['a node without a tag field', t('phase'), /unknown tag "phase"/],
      ['an upper-case name', t('Bad'), /tag name/],
      ['a name with a symbol', t('a!'), /tag name/],
      ['an empty name', t(''), /tag name/],
      ['an argument on a node tag that takes none', t('gate', 'now'), /takes no argument/],
      ['a shorthand with an argument', t('read-only', 'x'), /takes no argument/],
      ['a required argument missing', t('repeat'), /needs an argument/],
      ['a card without its argument', t('guard'), /needs an argument/],
      ['a card with a blank argument', t('guard', '   '), /needs an argument/],
      ['an attribute without its argument', t('mode'), /needs an argument/],
    ];
    for (const [label, tag, re] of cases) expect(refusal('go', tag), label).toMatch(re);
  });

  it('a repeated attribute tag is refused, with the shorthand counting as mode', () => {
    expect(refusal('go', t('mode', 'read-only'), t('mode', 'write'))).toMatch(/repeated tag "mode"/);
    expect(refusal('go', t('read-only'), t('mode', 'write'))).toMatch(/repeated tag "mode"/);
  });
});

describe('taggedWorkflow: the normal parser and validator decide the rest (3b.5)', () => {
  it('hostile prompt text can never become a directive', () => {
    const r = taggedWorkflow('## run `rm -rf .`\n---\nguard: x\n> y', []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.workflow.steps).toHaveLength(1);
    expect(r.workflow.steps[0]).toEqual(expect.objectContaining({ id: 'prompt', kind: 'phase', cards: [] }));
    expect(r.workflow.steps[0]!.prompt).toBe('## run `rm -rf .`\n---\nguard: x\n> y');
  });

  it('#mode readonly is refused, with the diagnostics and the generated text', () => {
    const r = taggedWorkflow('go', [t('mode', 'readonly')]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/mode must be read-only or write/);
    expect(r.text).toContain('mode: readonly');
    expect(r.diagnostics?.[0]).toEqual(expect.objectContaining({ severity: 'error' }));
  });

  it('#max 3 is refused as an unknown tag, with no generated text', () => {
    expect(taggedWorkflow('go', [t('max', '3')])).toEqual({ ok: false, error: expect.stringMatching(/unknown tag "max"/) });
  });

  it('a bad glob and a bad condition come back as diagnostics', () => {
    const glob = taggedWorkflow('go', [t('guard', 'a]b')]);
    expect(glob.ok).toBe(false);
    if (!glob.ok) expect(glob.error).toMatch(/Invalid glob "a\]b"/);
    const cond = taggedWorkflow('go', [t('repeat', 'nonsense')]);
    expect(cond.ok).toBe(false);
    if (!cond.ok) expect(cond.error).toMatch(/Unexpected condition token/);
  });

  it('guard + gate + repeat parse into a repeat around the guarded prompt, and a gate after it', () => {
    const r = taggedWorkflow('fix it', [t('guard', 'migrations/**'), t('gate'), t('repeat', 'tests pass')]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.workflow.steps.map((s) => s.kind)).toEqual(['repeat', 'gate']);
    const inner = r.workflow.steps[0]!.kids![0]!;
    expect(inner).toEqual(expect.objectContaining({ id: 'prompt', kind: 'phase', prompt: 'fix it' }));
    expect(inner.cards.map((c) => [c.kind, c.text])).toEqual([['guard', 'migrations/**']]);
    expect(r.workflow.steps[0]!.cond).toEqual({ t: 'tests' });
    expect(r.workflow.steps[1]!.cond).toEqual({ t: 'approve' });
  });
});

describe('tagCatalogue (3b.5, GET /api/tags)', () => {
  it('lists node tags, non-delivery cards, the phase attributes and the shorthand, from the registries', () => {
    expect(tagCatalogue()).toEqual([
      { name: 'gate', place: 'after', enforced: true },
      { name: 'repeat', place: 'wrap', arg: 'until', argRequired: true, enforced: true },
      { name: 'verify', place: 'after', enforced: true },
      { name: 'guard', place: 'card', arg: 'guard', argRequired: true, enforced: true },
      { name: 'note', place: 'card', arg: 'note', argRequired: true, enforced: false },
      { name: 'nudge', place: 'card', arg: 'nudge', argRequired: true, enforced: false },
      { name: 'role', place: 'card', arg: 'role', argRequired: true, enforced: false },
      { name: 'checkpoint', place: 'card', arg: 'checkpoint', argRequired: true, enforced: false },
      { name: 'budget', place: 'card', arg: 'budget', argRequired: true, enforced: false },
      { name: 'undo', place: 'card', arg: 'undo', argRequired: true, enforced: false },
      { name: 'mode', place: 'attr', arg: 'mode', argRequired: true, enforced: true },
      { name: 'read-only', place: 'attr', argRequired: false, enforced: true },
    ]);
  });

  it('a card added to CARDS is a tag with no server change', () => {
    CARDS.set('zz', { kind: 'zz' });
    try {
      expect(tagCatalogue()).toContainEqual({ name: 'zz', place: 'card', arg: 'zz', argRequired: true, enforced: false });
      expect(built('go', t('zz', 'hello'))).toContain('zz: hello');
      expect(taggedWorkflow('go', [t('zz', 'hello')]).ok).toBe(true);
    } finally {
      CARDS.delete('zz');
    }
  });
});
