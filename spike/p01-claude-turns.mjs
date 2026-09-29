// P0.1: three turns in one Claude session over stream-json.
import { startClaude, record } from './lib.mjs';

const ver = process.argv[2] || 'unknown';
const c = startClaude(['--max-turns', '2'], { fixture: `claude-${ver}-turns.jsonl` });
const t0 = Date.now();
const init = c.next((m) => m.type === 'system' && m.subtype === 'init', 120_000).catch(() => null);
const r1 = await c.turn('Reply with exactly the word ONE and nothing else.');
const first = Date.now() - t0;
const r2 = await c.turn('Reply with exactly the word TWO and nothing else.');
const r3 = await c.turn('Reply with exactly the word THREE and nothing else.');
c.close();
const initMsg = await init;
const texts = [r1, r2, r3].map((r) => String(r.result ?? '').trim());
const sessions = new Set([r1, r2, r3].map((r) => r.session_id));
const pass = /ONE/.test(texts[0]) && /TWO/.test(texts[1]) && /THREE/.test(texts[2]) && sessions.size === 1;
record('P0.1', pass, `replies=${JSON.stringify(texts)} sessions=${sessions.size} first_turn_ms=${first} ` +
  `cost=${[r1, r2, r3].map((r) => r.total_cost_usd).join('/')} ` +
  `init=${initMsg ? 'yes' : 'no'} capabilities=${JSON.stringify(initMsg?.capabilities ?? null)} ` +
  `apiKeySource=${initMsg?.apiKeySource ?? '?'} model=${initMsg?.model ?? '?'}`);
