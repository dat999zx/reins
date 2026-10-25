import { describe, it, expect } from 'vitest';
import { BUILT_IN_LINE, cardsOf, installIds, needsLine, preTicked, resultLine, type ChooserEntry } from '../src/firstRunCards.js';

const entry = (id: string, over: Partial<ChooserEntry> = {}): ChooserEntry => ({
  id, label: id.toUpperCase(), description: `The ${id} provider`, protocol: 'openai-chat', host: `api.${id}.test`, keyEnv: [`${id.toUpperCase()}_KEY`], untested: true, local: false, ...over,
});

describe('first-run cards', () => {
  it('offers every entry the server sent except claude-code, which is built in', () => {
    const all = [entry('alpha'), entry('claude-code'), entry('beta')];
    expect(cardsOf(all, ['claude-code']).map((c) => c.id)).toEqual(['alpha', 'beta']);
    expect(cardsOf(all, []).map((c) => c.id)).toEqual(['alpha', 'claude-code', 'beta']);
  });

  it('ticks the local programs from the start and nothing else', () => {
    const cards = cardsOf([entry('alpha', { local: true, keyEnv: [] }), entry('beta'), entry('gamma', { local: true, keyEnv: [] })], ['claude-code']);
    expect(preTicked(cards)).toEqual(['alpha', 'gamma']);
    expect(preTicked(cardsOf([entry('beta')], ['claude-code']))).toEqual([]);
  });

  it('names the key variables a card needs, or says it needs none', () => {
    expect(needsLine(entry('beta'))).toBe('needs BETA_KEY');
    expect(needsLine(entry('beta', { keyEnv: ['ONE_KEY', 'TWO_KEY'] }))).toBe('needs ONE_KEY or TWO_KEY');
    expect(needsLine(entry('alpha', { keyEnv: [] }))).toBe('needs no key');
  });

  it('installs the ticked ids in card order, and never an id that is not a card', () => {
    const cards = cardsOf([entry('alpha'), entry('claude-code'), entry('beta'), entry('gamma')], ['claude-code']);
    expect(installIds(cards, ['gamma', 'alpha'])).toEqual(['alpha', 'gamma']);
    expect(installIds(cards, ['claude-code', 'nope', 'beta'])).toEqual(['beta']);
    expect(installIds(cards, [])).toEqual([]);
  });

  it('words one install result per id: installed, or the server words', () => {
    expect(resultLine({ id: 'alpha', ok: true })).toBe('alpha: installed.');
    expect(resultLine({ id: 'beta', ok: false, error: 'is already installed. Use Re-install to replace your copy.' })).toBe('beta: is already installed. Use Re-install to replace your copy.');
  });

  it('says that Claude Code is built in', () => {
    expect(BUILT_IN_LINE).toBe('Claude Code is built in and ready if it is installed.');
  });
});
