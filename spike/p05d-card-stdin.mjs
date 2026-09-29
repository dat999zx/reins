// P0.5d (reviewer): card as a plain user message written to stdin WHILE a turn is running.
// Question: does claude pick it up inside the running turn, or only as the next turn?
import { startClaude, record } from './lib.mjs';

const c = startClaude(['--permission-mode', 'acceptEdits'], { fixture: 'claude-2.1.281-card-stdin.jsonl' });
let sentAt = null;
let toolUses = 0;
const results = [];
c.next((m) => {
  if (m.type === 'assistant') {
    for (const b of m.message?.content ?? []) {
      if (b.type === 'tool_use') {
        toolUses++;
        if (toolUses === 1 && !sentAt) {
          sentAt = Date.now();
          c.send('Card from the user: also mention the word PINEAPPLE at the very end of your final answer.');
        }
      }
    }
  }
  if (m.type === 'result') results.push(m);
  return results.length >= 2;
}, 300_000).catch(() => null);

const r1 = await c.turn('Read src/upload.mjs, then test.mjs, then migrations/0001.sql, one tool call at a time, and summarise each in one line.', 300_000);
// If the card was queued as a separate turn, a second result arrives.
const r2 = await c.next((m) => m.type === 'result' && m !== r1, 90_000).catch(() => null);
c.close();
const t1 = String(r1.result ?? '');
const t2 = String(r2?.result ?? '');
const inTurn = /PINEAPPLE/i.test(t1);
record('P0.5d', inTurn, `card_sent_after_tool_use=${!!sentAt} in_turn1=${inTurn} turn2=${r2 ? 'yes' : 'no'} turn2_has=${/PINEAPPLE/i.test(t2)} ` +
  `num_results=${results.length} cost=${r1.total_cost_usd}/${r2?.total_cost_usd ?? '-'} t1_tail=${JSON.stringify(t1.slice(-120))} t2_tail=${JSON.stringify(t2.slice(-120))}`);
