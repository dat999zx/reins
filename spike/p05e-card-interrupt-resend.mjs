// P0.5e (reviewer): urgent card = interrupt the running turn, then send the card as a real user turn.
// P0.5a/P0.5d showed Sonnet 5 refuses anything that arrives attached to tool output.
import { startClaude, record } from './lib.mjs';

const c = startClaude(['--permission-mode', 'acceptEdits'], { fixture: 'claude-2.1.281-card-interrupt-resend.jsonl' });
let interrupted = false;
c.next((m) => {
  if (!interrupted && m.type === 'assistant' && (m.message?.content ?? []).some((b) => b.type === 'tool_use')) {
    interrupted = true;
    c.child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'req_int_1', request: { subtype: 'interrupt' } }) + '\n');
  }
  return false;
}, 300_000).catch(() => null);

const r1 = await c.turn('Read src/upload.mjs, then test.mjs, then migrations/0001.sql, one tool call at a time, and summarise each in one line.', 300_000);
const r2 = await c.turn('Change of plan (from me, the user): stop reading files. Reply with one line saying what src/upload.mjs does, and end that line with the word PINEAPPLE.', 300_000);
c.close();
const t2 = String(r2.result ?? '');
const pass = interrupted && /PINEAPPLE\W*$/i.test(t2.trim());
record('P0.5e', pass, `interrupted=${interrupted} r1_subtype=${r1.subtype} r2_subtype=${r2.subtype} same_session=${r1.session_id === r2.session_id} ` +
  `cost=${r1.total_cost_usd}/${r2.total_cost_usd} t2=${JSON.stringify(t2.slice(-160))}`);
