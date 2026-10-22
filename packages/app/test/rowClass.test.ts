import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockRow, ROW_CLASSES } from '../src/BlockRow.js';
import { ROW_CLASSES as SERVER_CLASSES } from '../../server/src/mods/kinds.js';

const html = (className?: string, details?: string) => renderToStaticMarkup(createElement(BlockRow, { text: 't', ...(details === undefined ? {} : { details }), ...(className === undefined ? {} : { className }) }));

describe('BlockRow className', () => {
  it('keeps the two allowed classes', () => {
    expect(html('sx-sub')).toBe('<div class="row sx-sub">t</div>');
    expect(html('faint', 'd')).toContain('<details class="row faint">');
  });

  it('draws a plain row for any other class, with or without details', () => {
    for (const c of ['bad', 'row bad', 'sx-sub faint', 'sx-sub bad', '', 'x" onclick="y', 'constructor', 'toString']) {
      expect(html(c), c).toBe('<div class="row">t</div>');
      expect(html(c, 'd'), c).toContain('<details class="row">');
    }
  });

  it('draws a plain row with no class', () => {
    expect(html()).toBe('<div class="row">t</div>');
  });

  it('allows exactly what the server allows', () => {
    expect([...ROW_CLASSES]).toEqual([...SERVER_CLASSES]);
  });
});
