import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The header's pickers, without a browser: the real Chat renders on the server, a stand-in picker keeps the props Chat gave each one, and `post` is a spy.
const seen: Record<string, any> = {};
const post = vi.fn(() => Promise.resolve());
vi.mock('../src/OptionPicker.js', () => ({ OptionPicker: (p: any) => { seen[p.label] = p; return null; } }));
vi.mock('../src/api.js', async (original) => ({ ...(await original<object>()), post }));

const { Chat } = await import('../src/Chat.js');
const { typedModel } = await import('../src/usage.js');
const { Rail } = await import('../src/Rail.js');

const providers = [
  { id: 'alpha', label: 'Alpha', defaultModel: 'a1', defaultEffort: 'low', efforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], models: [{ id: 'a1', label: 'A One', window: 1000 }, { id: 'a2', label: 'A Two' }] },
  { id: 'beta', label: 'Beta', defaultModel: 'b1', defaultEffort: '', efforts: [], models: [{ id: 'b1', label: 'B One', window: 64000 }] },
  { id: 'gamma', label: 'Gamma', defaultModel: 'g1', defaultEffort: '', efforts: [], models: [{ id: 'g1', label: 'G One' }] },
];
const sess = (more: object = {}) => ({
  id: 's1', cwd: 'D:\\p', autoApprove: false, status: 'idle', rows: [], lastSeq: 0, lastTs: 0, cost: 0, open: [], answers: {}, closed: {}, detached: [], calls: {}, queue: [],
  engine: 'alpha', model: 'a1', effort: 'low', installed: ['alpha', 'beta'], ...more,
}) as any;
const render = (s: any, extra: object = {}) => renderToStaticMarkup(createElement(Chat, {
  sess: s, catalogue: [], providers, takeRefill: (i: string) => i, tab: 'chat', onTab: () => {}, onState: () => {}, onDirty: () => {}, onError: () => {}, ...extra,
}));

beforeEach(() => { post.mockClear(); for (const k of Object.keys(seen)) delete seen[k]; });

describe('the Reasoning picker', () => {
  it('posts to this session, not to the site root (F6)', () => {
    render(sess());
    seen.Reasoning.onChange('high');
    expect(post).toHaveBeenCalledWith('/api/sessions/s1/settings', { effort: 'high' });
  });
  it("lists the efforts of the current model's provider; none disables nothing but is empty", () => {
    render(sess());
    expect(seen.Reasoning.options.map((o: any) => o.id)).toEqual(['low', 'high']);
    render(sess({ engine: 'beta', model: 'b1', effort: undefined }));
    expect(seen.Reasoning.options).toEqual([]);
  });
});

describe('the Model picker', () => {
  it('lists the session provider first, then the other usable providers, as provider:model', () => {
    render(sess({ engine: 'beta', model: 'b1' }));
    expect(seen.Model.options.map((o: any) => [o.group, o.id])).toEqual([['Beta', 'beta:b1'], ['Alpha', 'alpha:a1'], ['Alpha', 'alpha:a2']]);
    expect(seen.Model.value).toBe('beta:b1');
  });
  it('leaves out a provider the server does not list as installed and enabled, and one whose probe is not well', () => {
    render(sess({ installed: ['alpha', 'beta', 'gamma'] }), { engines: [{ id: 'beta', installed: true, loggedIn: false, problems: [] }] });
    expect(seen.Model.options.map((o: any) => o.id)).toEqual(['alpha:a1', 'alpha:a2', 'gamma:g1']);
    render(sess());
    expect(seen.Model.options.map((o: any) => o.id)).toEqual(['alpha:a1', 'alpha:a2', 'beta:b1']);
  });
  it('posts the chosen provider:model to this session', () => {
    render(sess());
    seen.Model.onChange('beta:b1');
    expect(post).toHaveBeenCalledWith('/api/sessions/s1/settings', { model: 'beta:b1' });
  });
  it('a typed id is a model on the session provider; with a colon it names its own provider', () => {
    render(sess());
    const own = seen.Model.other.own;
    expect(own).toBe('alpha');
    expect(typedModel('some-model', own)).toBe('alpha:some-model');
    expect(typedModel('beta:other', own)).toBe('beta:other');
  });
});

describe('a session whose provider is gone', () => {
  const words = 'This session uses zeta, which is not installed. Install it in Settings > Providers, or start a new session.';
  it('shows the server words, locks the Composer and the pickers', () => {
    const html = render(sess({ engine: 'zeta', model: 'z1', missing: words, installed: ['alpha'] }));
    expect(html).toContain(words.replace('>', '&gt;'));
    expect(html).toMatch(/<textarea[^>]*disabled/);
    expect(seen.Model.disabled).toBe(true);
    expect(seen.Model.title).toBe(words);
    expect(seen.Reasoning.disabled).toBe(true);
  });
  it('a healthy session has none of that', () => {
    const html = render(sess());
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
    expect(seen.Model.disabled).toBe(false);
  });
  it('is greyed in the rail, with the words as its title', () => {
    const s = sess({ missing: words, status: 'closed' });
    const html = renderToStaticMarkup(createElement(Rail, {
      state: { sessions: { s1: { ...s, status: 'idle' }, s2: { ...sess({ id: 's2' }) } } }, selected: null, onSelect: () => {}, onNew: () => {}, onPlus: () => {}, onRename: () => {}, onSettings: () => {}, pathBox: null,
    }));
    expect(html).toContain('class="dim"');
    expect(html.match(/class="dim"/g)).toHaveLength(1);
    expect(html).toContain(`title="${words.replace('>', '&gt;')}"`);
  });
});
