import { createContext } from 'react';
import type { StepInfo, StepMap, StepState } from './stepStatus.js';

// Status comes through a context, not props: a streamed row must not rebuild the blocks mid-drag.
export const StatusCtx = createContext<{ status: StepMap; show: boolean }>({ status: {}, show: false });

const STATE: Record<StepState, { text: string; words: string }> = {
  active: { text: 'running', words: 'running' },
  done: { text: '✓', words: 'done' },
  waiting: { text: 'waiting for you', words: 'waiting for you' },
  stuck: { text: 'out of attempts', words: 'out of attempts' },
};

export function StepChips({ i }: { i: StepInfo }) {
  const st = i.state && STATE[i.state];
  const tries = i.attempts === undefined ? undefined : i.state === 'stuck' ? `${i.attempts} tries used` : `attempt ${i.attempts + 1}`;
  const cost = i.cost > 0 ? `$${i.cost.toFixed(4)}` : undefined;
  const text = [st && st.text, tries, cost].filter(Boolean);
  const words = [st && st.words, tries, cost && `cost ${cost}`].filter(Boolean);
  return (
    <>
      {text.length > 0 && <span className={`sstate ${i.state ?? ''}`} role="img" aria-label={words.join(', ')}>{text.join(' · ')}</span>}
      {i.refusals > 0 && <span className="sstate bad" role="img" aria-label={`${i.refusals} blocked`}>{i.refusals} blocked</span>}
    </>
  );
}
