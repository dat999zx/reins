import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ENDED, StepChips } from '../src/StepChips.js';

const chips = (props: Parameters<typeof StepChips>[0]) => renderToStaticMarkup(createElement(StepChips, props));

describe('StepChips', () => {
  const running = { state: 'active' as const, refusals: 0, cost: 0 };
  it('says what the agent is thinking only when given a count', () => {
    expect(chips({ i: running, thinking: 1509 })).toContain('running, thinking… ~1,509 tokens');
    expect(chips({ i: running })).not.toContain('thinking');
  });
  it('names the model a reply ran on, in the text and in the words', () => {
    const html = chips({ i: { ...running, model: 'Opus 5.5' } });
    expect(html).toContain('running · on Opus 5.5');
    expect(html).toContain('running, on Opus 5.5');
    expect(chips({ i: running })).not.toContain(' on ');
  });
  it('names the three ended marks', () => {
    expect(Object.values(ENDED)).toEqual(['stopped here', 'failed here', 'left paused here']);
  });
});