import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Step } from '@reins/core';
import { PanelField } from '../src/BlockPanel.js';
import { KINDS } from '../src/canvasKinds.js';

const step = { id: 'subagent-1', kind: 'subagent', attrs: {}, cards: [], links: [] } as Step;
const models = [{ id: 'm1', label: 'Model One' }];
const html = (f: (typeof KINDS)['model']['fields'][number]) =>
  renderToStaticMarkup(createElement(PanelField, { f, step, ids: [], models, rev: 0, onCommit: () => {} }));

describe("the Model select's first option", () => {
  it("says what an empty model means when the field has `empty`", () => {
    const f = KINDS.subagent.fields.find((x) => x.key === 'model')!;
    expect(html(f)).toContain(`<option value="" selected="">(the session&#x27;s model)</option>`);
    expect(html(f)).not.toContain('(pick a model)');
  });
  it('is (pick a model) without it', () => {
    expect(html(KINDS.model.fields[0]!)).toContain('<option value="" selected="">(pick a model)</option>');
  });
});
