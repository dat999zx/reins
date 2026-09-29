// P0.6: codex app-server over stdio on Windows: turns, approval deny, steer, interrupt. Throwaway.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { record, gitDiff, gitReset, FIX, SCRATCH } from './lib.mjs';

const ver = (spawnSync('codex --version', { shell: true, encoding: 'utf8' }).stdout.match(/\d+\.\d+\.\d+\S*/) ?? ['unknown'])[0];
const POLICY = process.env.CODEX_POLICY || 'untrusted' // docs say `unlessTrusted`; the server rejects it and lists `untrusted`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let out = null;
const setFixture = (n) => { out?.end(); out = fs.createWriteStream(path.join(FIX, `codex-${ver}-${n}.jsonl`)); };
const redact = (s) => s.replace(/("email"\s*:\s*)"[^"]*"/g, '$1"<redacted>"');

const child = spawn('codex', ['app-server'], { cwd: SCRATCH, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = ''; child.stderr.on('data', (d) => { stderr += d; });
const msgs = []; let waiters = []; let nextId = 1;
let onRequest = () => ({ decision: 'decline' });
let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    out?.write(redact(line) + '\n');
    let m; try { m = JSON.parse(line); } catch { continue; }
    msgs.push(m);
    if (m.method && m.id !== undefined) { // server -> client request
      const res = onRequest(m);
      if (res !== undefined) send({ id: m.id, result: res }, true);
    }
    for (const w of waiters) w(m);
  }
});
function send(o, raw) {
  out?.write(JSON.stringify({ _sent: o }) + '\n');
  child.stdin.write(JSON.stringify(o) + '\n');
}
const waitFor = (pred, ms = 240_000) => new Promise((res, rej) => {
  const hit = msgs.find(pred); if (hit) return res(hit);
  const t = setTimeout(() => { waiters = waiters.filter((x) => x !== f); rej(new Error('timeout; stderr=' + stderr.slice(-300))); }, ms);
  const f = (m) => { if (pred(m)) { clearTimeout(t); waiters = waiters.filter((x) => x !== f); res(m); } };
  waiters.push(f);
});
const request = async (method, params) => {
  const id = nextId++;
  send({ method, id, params });
  const r = await waitFor((m) => m.id === id && !m.method, 60_000);
  if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return r.result;
};
let threadId;
const agentText = (from) => msgs.slice(from).filter((m) => m.method === 'item/completed' && m.params.item?.type === 'agentMessage').map((m) => m.params.item.text).join('\n');
async function turn(text) {
  const from = msgs.length;
  const r = await request('turn/start', { threadId, input: [{ type: 'text', text }] });
  const turnId = r.turn?.id;
  return { from, turnId, done: waitFor((m) => m.method === 'turn/completed' && (m.params.turn?.id === turnId || m.params.turnId === turnId)) };
}

const only = process.argv[2];
try {
  setFixture('turns');
  const init = await request('initialize', { clientInfo: { name: 'reins-spike', version: '0' } });
  send({ method: 'initialized', params: {} });
  const acct = await request('account/read', { refreshToken: false });
  const authMode = acct.account?.type ?? JSON.stringify(Object.keys(acct));
  const th = await request('thread/start', { cwd: SCRATCH, approvalPolicy: POLICY });
  threadId = th.thread?.id;
  console.log('init', JSON.stringify(init).slice(0, 200), 'auth', authMode, 'thread', threadId, 'policy echoed', th.approvalPolicy, 'sandbox', JSON.stringify(th.sandbox ?? th.sandboxPolicy));

  // --- a: three turns
  const replies = [];
  for (const w of ['ONE', 'TWO', 'THREE']) {
    const t = await turn(`Reply with exactly the word ${w} and nothing else.`);
    const d = await t.done; replies.push([d.params.turn?.status, agentText(t.from).trim()]);
  }
  record('P0.6a', replies.every(([s], i) => s === 'completed') && replies.every(([, t], i) => t.includes(['ONE', 'TWO', 'THREE'][i])),
    `windows=yes version=${ver} authMode=${authMode} approvalPolicy=${POLICY} replies=${JSON.stringify(replies)} server=${JSON.stringify(init).slice(0, 120)}`);

  // --- b: deny file change
  setFixture('deny'); await gitReset();
  const seen = [];
  onRequest = (m) => { seen.push(m.method); console.log('server request', m.method, JSON.stringify(m.params).slice(0, 200)); return { decision: 'decline' }; };
  let t = await turn('Add a column retries to migrations/0001.sql.');
  let d = await t.done;
  const diffB = await gitDiff('migrations/');
  const items = msgs.slice(t.from).filter((m) => m.method === 'item/completed').map((m) => `${m.params.item.type}:${m.params.item.status ?? ''}`);
  record('P0.6b', diffB === '' && seen.some((s) => /fileChange|commandExecution/.test(s)),
    `requests=${JSON.stringify(seen)} diff_empty=${diffB === ''} turn_status=${d.params.turn?.status} items=${JSON.stringify(items)} reply=${JSON.stringify(agentText(t.from).slice(0, 160))}`);
  await gitReset();

  // --- c: steer
  setFixture('steer');
  const seenC = [];
  onRequest = (m) => { seenC.push(m.method); return { decision: 'accept' }; }; // read-only prompt; accept shell reads
  const fromC = msgs.length;
  t = await turn('Read every file in src/ and test.mjs one at a time (one command per file, sequentially), then summarise them in two sentences.');
  await waitFor((m) => m.method === 'item/started' && msgs.indexOf(m) >= fromC && /commandExecution|mcpToolCall|fileChange/.test(m.params.item?.type), 120_000);
  let steerRes, steerErr;
  try { steerRes = await request('turn/steer', { threadId, expectedTurnId: t.turnId, input: [{ type: 'text', text: 'Reins card: end your final answer with the word PINEAPPLE.' }] }); } catch (e) { steerErr = e.message; }
  d = await t.done;
  const txt = agentText(t.from).trim();
  await gitReset();
  record('P0.6c', /PINEAPPLE\W*$/i.test(txt),
    `steer_result=${JSON.stringify(steerRes)} steer_err=${steerErr ?? 'none'} requests=${JSON.stringify([...new Set(seenC)])} turn_status=${d.params.turn?.status} tail=${JSON.stringify(txt.slice(-100))}`);

  // --- d: interrupt
  setFixture('interrupt');
  onRequest = () => ({ decision: 'accept' });
  const fromD = msgs.length;
  t = await turn('Run the shell command `ping -n 60 127.0.0.1` and then reply DONE.');
  await waitFor((m) => m.method === 'item/started' && msgs.indexOf(m) >= fromD && m.params.item?.type === 'commandExecution', 120_000);
  await sleep(2000);
  const t0 = Date.now();
  let intErr; try { await request('turn/interrupt', { threadId, turnId: t.turnId }); } catch (e) { intErr = e.message; }
  d = await Promise.race([t.done, sleep(30_000).then(() => null)]);
  record('P0.6d', d?.params.turn?.status === 'interrupted',
    `interrupt_err=${intErr ?? 'none'} completed_after_ms=${d ? Date.now() - t0 : 'none in 30s'} status=${d?.params.turn?.status}`);
} catch (e) {
  record('P0.6-error', false, `${e.message}`);
} finally {
  out?.end(); child.stdin.end();
  spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)]);
  await gitReset();
  process.exit(0);
}
