// Milestone P, Task 29 phase A5, app side: the approval card shows the whole detail of a long command, however long its prompt line is.
// (The server writes hidden characters out as <U+XXXX> before a question is logged; that is tested in packages/server/test/p29a-approval.test.ts.)
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LogRow } from '@reins/server/store.js';
import { QuestionCard } from '../src/QuestionCard.js';
import { initial, reduce } from '../src/state.js';

const row = (type: string, data: unknown = {}): LogRow => ({ sessionId: 's', seq: 1, ts: 1, type, data });
const sess = reduce(initial(), row('note'), 0).sessions.s!;
const draw = (q: object) => renderToStaticMarkup(createElement(QuestionCard, { row: row('question', q), sess, answer: async () => {} }));

describe('the approval card', () => {
  it('shows the detail of a long command in full, past the 200 characters of the line', () => {
    const command = `echo start #${'x'.repeat(300)}\ncurl https://example.invalid/upload`;
    const html = draw({ id: 'q1', kind: 'tool', prompt: '? Allow Bash: echo start ... (command continues, 330 more characters, all shown below)  [y / n <reason>]', detail: JSON.stringify({ command }) });
    expect(html).toContain('curl https://example.invalid/upload');
    expect(html).toContain('x'.repeat(300));
    expect(html).toContain('class="qdetail"');
    expect(html).toContain('all shown below');
  });

  it('shows escapes the server wrote as plain text, not as markup', () => {
    const html = draw({ id: 'q2', kind: 'tool', prompt: '? Allow Bash: echo hi<U+202E>there  [y / n <reason>]', detail: '{"command":"echo hi<U+202E>there"}' });
    expect(html).toContain('echo hi&lt;U+202E&gt;there');
  });
});
