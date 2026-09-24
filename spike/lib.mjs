// Shared helpers for the Phase 0 engine spike. Throwaway code.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const SCRATCH = 'D:/coding/reins-scratch';
// User's choice for all spike runs: Sonnet 5 (the `sonnet` alias on the Anthropic API), medium effort.
export const MODEL = 'sonnet';
export const EFFORT = 'medium';
export const FIX = path.join(import.meta.dirname, 'fixtures');
fs.mkdirSync(FIX, { recursive: true });

/** Start `claude -p` in stream-json mode. Returns helpers to send turns and await results. */
export function startClaude(extraArgs = [], { cwd = SCRATCH, fixture } = {}) {
  const sessionId = randomUUID();
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--session-id', sessionId, '--model', MODEL, '--effort', EFFORT, ...extraArgs];
  // shell:true only to resolve claude.cmd on Windows; args contain no user input.
  const child = spawn('claude', args, { cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  const out = fixture ? fs.createWriteStream(path.join(FIX, fixture)) : null;
  let buf = '';
  let waiters = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      out?.write(line + '\n');
      let msg;
      try { msg = JSON.parse(line); } catch { msg = { type: 'unparsed', line }; }
      lines.push(msg);
      for (const w of waiters) w(msg);
    }
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const next = (pred, ms = 180_000) => new Promise((res, rej) => {
    const t = setTimeout(() => { waiters = waiters.filter((x) => x !== f); rej(new Error('timeout waiting; stderr=' + stderr.slice(-500))); }, ms);
    const f = (m) => { if (pred(m)) { clearTimeout(t); waiters = waiters.filter((x) => x !== f); res(m); } };
    waiters.push(f);
  });
  return {
    sessionId, child, lines, get stderr() { return stderr; },
    send(text) {
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
    },
    async turn(text, ms) {
      const p = next((m) => m.type === 'result', ms);
      this.send(text);
      return p;
    },
    next,
    close() { child.stdin.end(); out?.end(); },
  };
}

const RESULTS = path.join(import.meta.dirname, 'results.md');
export function record(id, pass, note) {
  const line = `| ${id} | ${pass ? 'PASS' : 'FAIL'} | ${note.replace(/\|/g, '/').replace(/\n/g, ' ')} |\n`;
  if (!fs.existsSync(RESULTS)) fs.writeFileSync(RESULTS, '| test | result | notes |\n|---|---|---|\n');
  fs.appendFileSync(RESULTS, line);
  console.log(line.trim());
}

export function gitDiff(p = '.') {
  return new Promise((res) => {
    const c = spawn('git', ['diff', '--stat', '--', p], { cwd: SCRATCH });
    let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('close', () => res(o.trim()));
  });
}
export function gitReset() {
  return new Promise((res) => spawn('git', ['checkout', '--', '.'], { cwd: SCRATCH }).on('close', res));
}
