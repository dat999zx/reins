import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LogRow } from '@reins/server/store.js';
import { Md } from '../src/Md.js';
import { renderRow } from '../src/rows.js';
import { initial, reduce } from '../src/state.js';

const md = (text: string) => renderToStaticMarkup(createElement(Md, { text }));
const row = (type: string, data: unknown = {}): LogRow => ({ sessionId: 's', seq: 1, ts: 1, type, data });
const sess = reduce(initial(), row('note'), 0).sessions.s!;
const ctx = { sess, act: { answer: async () => {}, resume: () => {} } };

describe('markdown in the chat', () => {
  it('bold, inline code, a fenced block, a list and a table become elements', () => {
    expect(md('**Spec for step 3**')).toContain('<strong>Spec for step 3</strong>');
    expect(md('use `npm test`')).toContain('<code>npm test</code>');
    expect(md('```\nlet a = 1;\n```')).toContain('<pre><code>let a = 1;\n</code></pre>');
    expect(md('- one\n- two')).toMatch(/<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
    expect(md('| a | b |\n|---|---|\n| 1 | 2 |')).toContain('<table>');
    expect(md('~~gone~~')).toContain('<del>gone</del>');
  });

  it('raw html is not emitted, a javascript: link has no href, a normal link opens in a new tab', () => {
    expect(md('<script>alert(1)</script>')).not.toContain('<script');
    expect(md('[x](javascript:alert(1))')).not.toContain('javascript:');
    const a = md('[site](https://example.com)');
    expect(a).toContain('href="https://example.com"');
    expect(a).toContain('target="_blank"');
    expect(a).toContain('rel="noreferrer noopener"');
  });

  it('plain text keeps its words; the agent text, its reasoning and a subagent result draw it', () => {
    expect(md('just words here')).toContain('just words here');
    expect(renderToStaticMarkup(renderRow(row('engine', { type: 'text', text: '**hi**' }), ctx))).toContain('<div class="msg agent txt"><div class="md"><p><strong>hi</strong></p></div></div>');
    expect(renderToStaticMarkup(renderRow(row('engine', { type: 'thinking', tokens: 3, text: 'a `b`' }), { ...ctx, thinking: { heads: new Set([1]), now: 1 } } as never))).toContain('<code>b</code>');
    expect(renderToStaticMarkup(renderRow(row('subagent_result', { title: 't', text: '# Plan\n- x' }), ctx))).toContain('<h1>Plan</h1>');
    expect(renderToStaticMarkup(renderRow(row('subagent_result', { title: 't' }), ctx))).toContain('handed back');   // an old row with no text
  });
});
