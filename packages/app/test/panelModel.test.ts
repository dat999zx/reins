import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Step } from '@reins/core';
import { PanelField } from '../src/BlockPanel.js';
import { KINDS } from '../src/canvasKinds.js';

const step = { id: 'subagent-1', kind: 'subagent', attrs: {}, cards: [], links: [] } as Step;
const models = [{ id: 'm1', label: 'Model One' }];
const efforts = [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }];
const html = (f: (typeof KINDS)['model']['fields'][number]) =>
  renderToStaticMarkup(createElement(PanelField, { f, step, ids: [], models, sessionModel: { id: 'm1', label: 'Model One' }, efforts, sessionEffort: { id: 'medium', label: 'Medium' }, rev: 0, onCommit: () => {} }));

describe("the panel's Model picker", () => {
  it("shows the session's model by name when the field inherits it", () => {
    const f = KINDS.subagent.fields.find((x) => x.key === 'model')!;
    expect(html(f)).toContain('<option value="" selected="">Model One</option>');
    expect(html(f)).not.toContain('Pick a model');
    expect(html(f)).not.toContain('(the session');
  });
  it("the Reasoning field lists the provider's levels and shows the session's by name when blank", () => {
    const f = KINDS.subagent.fields.find((x) => x.key === 'reasoning')!;
    expect(html(f)).toContain('<option value="" selected="">Medium</option><option value="medium">Medium</option><option value="high">High</option>');
    expect(html(f)).not.toContain('Model One');
  });
  it('asks to pick a model without it', () => {
    expect(html(KINDS.model.fields[0]!)).toContain('<option value="" disabled="" selected="">Pick a model</option>');
  });
});
