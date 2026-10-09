import { createContext } from 'react';
import { STATE_WORDS, type StepInfo, type StepMap, type StepState } from './stepStatus.js';

// Status comes through a context, not props: a streamed row must not rebuild the blocks mid-drag.
export const StatusCtx = createContext<{ status: StepMap; show: boolean; ended?: { id: string; phase: keyof typeof ENDED }; thinking?: number }>({ status: {}, show: false });

const STATE: Record<StepState, { text: string; words: string }> = {
  active: { text: STATE_WORDS.active, words: STATE_WORDS.active },
  done: { text: '✓', words: STATE_WORDS.done },
  waiting: { text: STATE_WORDS.waiting, words: STATE_WORDS.waiting },
  stuck: { text: STATE_WORDS.stuck, words: STATE_WORDS.stuck },
  failed: { text: STATE_WORDS.failed, words: STATE_WORDS.failed },
};

// The ended run's mark on the block it stopped at, failed at or was left paused at (the glyphs are CSS).
export const ENDED: Record<'stopped' | 'failed' | 'paused', string> = { stopped: 'stopped here', failed: 'failed here', paused: 'left paused here' };

export function StepChips({ i, thinking }: { i: StepInfo; thinking?: number }) {
  const base = i.state && STATE[i.state];
  const think = thinking === undefined ? undefined : `thinking… ~${thinking.toLocaleString('en-US')} tokens`;
  const st = base && i.why ? { text: `${base.text} (${i.why})`, words: `${base.words} (${i.why})` } : base;
  const tries = i.attempts === undefined ? undefined : i.state === 'stuck' ? `${i.attempts} tries used` : `attempt ${i.attempts + 1}`;
  const cost = i.cost > 0 ? `$${i.cost.toFixed(4)}` : undefined;
  const text = [st && st.text, think, tries, cost].filter(Boolean);
  const words = [st && st.words, think, tries, cost && `cost ${cost}`].filter(Boolean);
  return (
    <>
      {text.length > 0 && <span className={`sstate ${i.state ?? ''}`} role="img" aria-label={words.join(', ')}>{text.join(' · ')}</span>}
      {i.refusals > 0 && <span className="sstate bad" role="img" aria-label={`${i.refusals} blocked`}>{i.refusals} blocked</span>}
    </>
  );
}
