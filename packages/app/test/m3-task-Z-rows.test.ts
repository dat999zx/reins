// M3 Task 7: the rows of `subagent_started` and `subagent_result` were two row files; they are now `view.rows` templates in the `subagent` manifest.
// `m3-task-Z-rows.expected.json` was recorded at HEAD with the row files. The same data must draw the same markup; the few cases that differ on purpose are
// written out in the last test (and the one general difference, an empty body, is the `noBody` step).
// To record again (only at a commit where the answer is right): `PIN_WRITE=1 npx vitest run --project app packages/app/test/m3-task-Z-rows.test.ts`.
import fs from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LogRow } from '@reins/server/store.js';
import { drawable, renderRow, rowTypes } from '../src/rows.js';
import { initial, reduce } from '../src/state.js';
import { UNKNOWN_MARK } from '../src/unknown.js';

const EXPECTED = new URL('./m3-task-Z-rows.expected.json', import.meta.url);
const row = (type: string, data?: unknown): LogRow => ({ sessionId: 's', seq: 1, ts: 1, type, data });
const sess = reduce(initial(), row('note'), 0).sessions.s!;
const ctx = { sess, act: { answer: async () => {}, resume: () => {} } };
const html = (r: LogRow) => renderToStaticMarkup(renderRow(r, ctx) as never);
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);

const STARTED: unknown[] = [
  {}, { title: 'research' }, { title: 'research', label: 'Haiku 5.5' }, { title: 'research', model: 'claude-haiku-5-5' },
  { title: 'research', label: 'Haiku 5.5', model: 'claude-haiku-5-5' }, { title: 'research', resumed: true }, { title: 'research', resumed: true, label: 'H' },
  { title: 'research', resumed: false, label: 'H' }, { title: '<b>x</b> & "y"', label: '<i>l</i>' }, { title: 7, label: 8 }, null, 'text',
  { step: 's', title: 'research', track: 'a' },
];
const RESULT: unknown[] = [
  {}, { title: 'research' }, { title: 'research', text: 'found it' }, { title: 'research', text: 'found it', cost: 0.0640898 }, { title: 'research', text: '', cost: 0 },
  { title: 'research', text: 'found it', cost: 1, unknown: true }, { title: 'research', cost: 0.5, unknown: false },
  { title: 'r', text: '# Plan\n- x\n- y\n\n`code`' }, { title: 'r', text: '<script>alert(1)</script> **bold**' }, { title: 't', text: 'line one\nline two', cost: 0.02 },
  { title: 'r', text: 'x', cost: 'NaN' }, { title: 'r', text: 'x'.repeat(5000) }, null,
];

describe('M3 Task 7: the subagent rows draw what the row files drew', () => {
  it('the markup of every case matches the record made at HEAD', () => {
    const actual = JSON.parse(JSON.stringify({
      started: STARTED.map((d) => html(row('subagent_started', d))),
      result: RESULT.map((d) => html(row('subagent_result', d))),
      listed: [rowTypes().includes('subagent_started'), rowTypes().includes('subagent_result'), drawable(row('subagent_started', {})), drawable(row('subagent_result', {}))],
    }));
    if (process.env.PIN_WRITE === '1') { fs.writeFileSync(EXPECTED, JSON.stringify(actual, null, 1) + '\n'); return; }
    // The one general difference, on purpose: a result with no text drew a collapsible with an empty body; the view's `details` filled empty draws a plain row.
    const noBody = (s: string) => s.replace(/^<details class="row sx-sub"><summary>(.*)<\/summary><div class="md"><\/div><\/details>$/s, '<div class="row sx-sub">$1</div>');
    const was = JSON.parse(fs.readFileSync(EXPECTED, 'utf8')) as typeof actual;
    expect(actual).toEqual({ ...was, result: was.result.map(noBody) });
  });

  it('the recording is not empty', () => {
    const e = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
    expect(e.started).toHaveLength(STARTED.length);
    expect(e.result).toHaveLength(RESULT.length);
    expect(e.started[5]).toContain('resumed on');
    expect(e.result[3]).toContain('($0.0641)');
    expect(e.result[5]).toContain(`($1.0000${UNKNOWN_MARK})`);
    expect(e.listed).toEqual([true, true, true, true]);
  });

  // Data the row files drew raw and the filler (the one filler of every view string) shows safe, or another way. Each case is written out.
  it('the cases that differ on purpose', () => {
    const started = (d: unknown) => html(row('subagent_started', d));
    const result = (d: unknown) => html(row('subagent_result', d));
    expect(started({ title: `a${RLO}b`, label: `c${ZWSP}d` })).toBe('<div class="row sx-sub">Subagent a&lt;U+202E&gt;b started on c&lt;U+200B&gt;d.</div>');
    expect(started({ title: 'two\nlines', model: 'm' })).toBe('<div class="row sx-sub">Subagent two\\nlines started on m.</div>');
    expect(started({ title: 'x', label: '', model: 'raw' })).toBe('<div class="row sx-sub">Subagent x started on raw.</div>');   // an empty label is no label
    expect(result({ title: 'r', text: 'x', cost: Infinity })).toBe('<details class="row sx-sub"><summary>Subagent r handed back its result.</summary><div class="md"><p>x</p></div></details>');   // JSON cannot carry it
    expect(result({ title: 'r', text: 'x', unknown: true })).toContain(`its result${UNKNOWN_MARK}.</summary>`);   // the mark with no figure: core always logs the cost with it, so this data does not occur
    expect(result({ title: 't', text: `a${RLO}b`, cost: 0.02 })).toContain('<p>a&lt;U+202E&gt;b</p>');
  });
});
