// The HTTP API and the SSE stream (plan 15d 3b.6 lines 1500-1552, 3b.7 line 1553, 3b.8 HTTP tests).
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { openStore } from '../src/store.js';
import { takeLock } from '../src/lock.js';
import { tagCatalogue } from '../src/tags.js';
import { until } from './helpers.js';
import { askedQuestion, boot, cleanup, openStream, PROBE, request, tmpDir } from './http-helpers.js';

afterEach(cleanup);

const TURN = { fixture: 'claude-2.1.281-turns.jsonl', turn: 0 };
const GOOD = '---\nreins: 1\nname: t\nbudget: { turns: 30, minutes: 30 }\nalways: []\n---\n\n## phase go\n> do it\n';
const NO_BUDGET = '---\nreins: 1\nname: t\n---\n\n## phase go\n> do it\n';

describe('auth, Host and Origin (3b.6 1514-1521, 1552)', () => {
  it('every /api request needs the bearer token; without it nothing is created', async () => {
    const w = await boot();
    const post = (headers: Record<string, string>) =>
      request(w.srv, 'POST', '/api/sessions', { body: { cwd: w.cwd, engine: 'claude' }, auth: false, headers });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: `Bearer ${'0'.repeat(64)}` })).status).toBe(401);
    expect((await post({ authorization: w.srv.token })).status).toBe(401);
    expect((await request(w.srv, 'GET', '/api/state', { auth: false })).status).toBe(401);
    expect(w.store.listSessions()).toEqual([]);
    expect((await w.api('GET', '/api/state')).status).toBe(200);
  });

  it('Host must be exactly 127.0.0.1:<port>', async () => {
    const w = await boot();
    const port = w.srv.port;
    for (const host of [`localhost:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`, `evil.example:${port}`, `127.0.0.1:${port}.evil.example`]) {
      const r = await w.api('GET', '/api/state', { headers: { host } });
      expect(r.status, host).toBe(403);
    }
    expect((await w.api('GET', '/api/state', { headers: { host: `127.0.0.1:${port}` } })).status).toBe(200);
  });

  it('an Origin that is not http://127.0.0.1:<port> is refused; no Origin, or the right one, is fine', async () => {
    const w = await boot();
    const port = w.srv.port;
    for (const origin of ['http://evil.example', `http://localhost:${port}`, `http://127.0.0.1:${port + 1}`, 'null']) {
      const r = await w.api('POST', '/api/state/probe', { headers: { origin } });
      expect(r.status, origin).toBe(403);
    }
    expect(w.probes()).toBe(1);
    expect((await w.api('POST', '/api/state/probe', { headers: { origin: `http://127.0.0.1:${port}` } })).status).toBe(200);
    expect((await w.api('GET', '/api/state')).status).toBe(200);
  });

  it('?token= works on /api/stream only', async () => {
    const w = await boot();
    const q = (p: string) => request(w.srv, 'GET', `${p}?token=${w.srv.token}`, { auth: false });
    expect((await q('/api/state')).status).toBe(401);
    expect((await q('/api/tags')).status).toBe(401);
    const s = openStream(w.srv);
    const res = await s.ready;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect((await request(w.srv, 'GET', '/api/stream', { auth: false })).status).toBe(401);
  });

  it('listens on 127.0.0.1 only: the port refuses a connection on the machine\'s other addresses', async () => {
    const w = await boot();
    const other = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (!other) return; // a machine with loopback only has no other address to try
    const outcome = await new Promise<string>((resolve) => {
      const c = net.connect(w.srv.port, other.address);
      c.on('connect', () => { c.destroy(); resolve('connected'); });
      c.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
    });
    expect(outcome).toBe('ECONNREFUSED');
  });

  it('a non-ASCII ?token= with the right character count is 401, and the server stays up', async () => {
    const w = await boot();
    const bad = `${'a'.repeat(63)}é`;
    expect(bad).toHaveLength(w.srv.token.length);
    const r = await request(w.srv, 'GET', `/api/stream?token=${encodeURIComponent(bad)}`, { auth: false });
    expect(r.status).toBe(401);
    expect((await w.api('GET', '/api/state')).status).toBe(200);
  });
});

describe('body cap, errors and headers (3b.6 1520-1521, 1552)', () => {
  it('a body over 1 MB is 413 and does nothing; one just under it goes through', async () => {
    const w = await boot();
    const id = await w.session();
    const big = await w.api('POST', `/api/sessions/${id}/message`, { raw: JSON.stringify({ text: 'x'.repeat(1024 * 1024 + 10) }) });
    expect(big.status).toBe(413);
    expect(big.json.error).toContain('1 MB');
    expect(w.rows(id, 'message')).toEqual([]);
    const under = await w.post(id, 'settings', { title: 'y'.repeat(1024 * 1024 - 100) });
    expect(under.status).toBe(200);
    expect(w.rows(id, 'settings')).toHaveLength(1);
    expect((await w.api('GET', '/api/state')).status).toBe(200);
  });

  it('every response carries Referrer-Policy, and an error is exactly { error } with no stack', async () => {
    const w = await boot();
    const id = await w.session();
    const replies = [
      await w.api('GET', '/api/state'),
      await request(w.srv, 'GET', '/api/state', { auth: false }),
      await w.api('GET', '/nope'),
      await w.api('GET', '/api/nope'),
      await w.api('GET', '/api/state', { headers: { host: 'evil.example' } }),
      await w.api('POST', '/api/sessions', { raw: '{oops' }),
    ];
    for (const r of replies) expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(replies.map((r) => r.status)).toEqual([200, 401, 404, 404, 403, 400]);
    for (const r of replies.slice(1)) {
      expect(Object.keys(r.json)).toEqual(['error']);
      expect(r.json.error).toEqual(expect.any(String));
    }
    w.store.close();
    const broken = await w.api('GET', `/api/sessions/${id}/log`);
    expect(broken.status).toBe(500);
    expect(broken.headers['referrer-policy']).toBe('no-referrer');
    expect(Object.keys(broken.json)).toEqual(['error']);
    expect(broken.json.error).toBe('Internal error.');
    expect(broken.text).not.toMatch(/\n\s+at |\.ts:\d+/);
  });

  it('bad input is 400, an unknown session or route is 404, and nothing is logged for them', async () => {
    const w = await boot();
    const id = await w.session();
    const file = path.join(w.cwd, '.fake-script.json');
    const create = (body: unknown) => w.api('POST', '/api/sessions', { body });
    const cases: Array<[string, number, Promise<{ status: number }>]> = [
      ['no cwd', 400, create({ engine: 'claude' })],
      ['relative cwd', 400, create({ cwd: 'rel', engine: 'claude' })],
      ['missing folder', 400, create({ cwd: path.join(w.cwd, 'nope'), engine: 'claude' })],
      ['cwd is a file', 400, create({ cwd: file, engine: 'claude' })],
      ['engine codex', 400, create({ cwd: w.cwd, engine: 'codex' })],
      ['model not a string', 400, create({ cwd: w.cwd, engine: 'claude', model: 5 })],
      ['array body', 400, w.api('POST', '/api/sessions', { raw: '[]' })],
      ['message without text', 400, w.post(id, 'message', {})],
      ['message with blank text', 400, w.post(id, 'message', { text: '  ' })],
      ['tags not a list', 400, w.post(id, 'message', { text: 'x', tags: 'gate' })],
      ['tag without a name', 400, w.post(id, 'message', { text: 'x', tags: [{ arg: 'a' }] })],
      ['unknown tag', 400, w.post(id, 'message', { text: 'x', tags: [{ tag: 'nope' }] })],
      ['#mode readonly', 400, w.post(id, 'message', { text: 'x', tags: [{ tag: 'mode', arg: 'readonly' }] })],
      ['card kind', 400, w.post(id, 'card', { text: 'a', kind: 'bogus' })],
      ['card without text', 400, w.post(id, 'card', { kind: 'steer' })],
      ['answer with a number', 400, w.post(id, 'answer', { questionId: 1, answer: 'y' })],
      ['settings autoApprove', 400, w.post(id, 'settings', { autoApprove: 'yes' })],
      ['run without a path', 400, w.post(id, 'run', {})],
      ['run with a missing relative path', 400, w.post(id, 'run', { path: 'missing.reins.md' })],
      ['cwd with a NUL byte', 400, create({ cwd: `${w.cwd}\0x`, engine: 'claude' })],
      ['a body that is not JSON', 400, w.api('POST', `/api/sessions/${id}/message`, { raw: '{"text": "x' })],
      ['resume without a runId', 400, w.post(id, 'resume', {})],
      ['resume an unknown run', 409, w.post(id, 'resume', { runId: 'nope' })],
      ['answer an unknown question', 409, w.answer(id, 'nope', 'y')],
      ['unknown session', 404, w.post('nosuch', 'message', { text: 'x' })],
      ['unknown action', 404, w.post(id, 'explode')],
      ['a prototype method as the action', 404, w.post(id, 'constructor')],
      ['GET on a POST route', 404, w.api('GET', `/api/sessions/${id}/message`)],
      ['log after=x', 400, w.api('GET', `/api/sessions/${id}/log?after=x`)],
      ['log after=-1', 400, w.api('GET', `/api/sessions/${id}/log?after=-1`)],
      ['log of an unknown session', 404, w.api('GET', '/api/sessions/nosuch/log')],
    ];
    const replies = await Promise.all(cases.map(([, , p]) => p));
    cases.forEach(([label, want], i) => expect(replies[i]!.status, label).toBe(want));
    expect(w.rows(id, 'message')).toEqual([]);
    expect(w.store.listSessions()).toHaveLength(1);
  });
});

describe('state, probing and sessions (3b.6 1526-1528, 1543)', () => {
  it('/api/state omits engineSessionId and never probes; POST /api/state/probe probes once more', async () => {
    const w = await boot([TURN]);
    expect(w.probes()).toBe(1);
    const id = await w.session({ model: 'sonnet', title: 't' });
    await w.say(id, 'hello');
    await until(() => w.rows(id, 'turn_ended').length === 1);
    expect(w.store.getSession(id)!.engineSessionId).toEqual(expect.any(String));
    const s = await w.api('GET', '/api/state');
    expect(s.json.engines).toEqual([{ id: 'claude', ...PROBE }]);
    expect(s.json.sessions).toEqual([expect.objectContaining({ id, cwd: w.cwd, engine: 'claude', model: 'sonnet', title: 't', autoApprove: false, status: 'idle' })]);
    expect(s.text).not.toContain('engineSessionId');
    await w.api('GET', '/api/state');
    await w.api('GET', '/api/state');
    expect(w.probes()).toBe(1);
    const p = await w.api('POST', '/api/state/probe');
    expect(w.probes()).toBe(2);
    expect(p.json).toEqual({ engines: [{ id: 'claude', ...PROBE }] });
  });

  it('a probe that throws becomes an installed:false entry instead of stopping the server', async () => {
    const w = await boot([], { probe: async () => { throw new Error('no claude here'); } });
    const s = await w.api('GET', '/api/state');
    expect(s.json.engines).toEqual([expect.objectContaining({ id: 'claude', installed: false, problems: [expect.stringContaining('no claude here')] })]);
  });

  it('a second answer to the same question is 409, and the first one still decides', async () => {
    const w = await boot([{ fixture: 'claude-2.1.281-approval-allow-hold.jsonl', approve: true }]);
    const id = await w.session();
    expect((await w.say(id, 'edit it')).status).toBe(200);
    const q = await askedQuestion(w.store, id, 'tool');
    expect((await w.answer(id, q.id, 'y')).status).toBe(200);
    const again = await w.answer(id, q.id, 'n');
    expect(again.status).toBe(409);
    expect(again.json.error).toEqual(expect.any(String));
    await until(() => w.rows(id, 'turn_ended').length === 1);
    expect(w.fake.log().filter((e) => e.kind === 'approve').map((e) => e.decision.behavior)).toEqual(['allow']);
  }, 20_000);

  it('/close ends the engine, keeps the history, and the next message reopens it with --resume', async () => {
    const w = await boot();
    const id = await w.session();
    await w.say(id, 'one');
    await until(() => w.rows(id, 'turn_ended').length === 1);
    expect((await w.post(id, 'close')).status).toBe(200);
    expect((await w.api('GET', '/api/state')).json.sessions[0].status).toBe('closed');
    await w.say(id, 'two');
    await until(() => w.rows(id, 'turn_ended').length === 2);
    const args = w.fake.log().filter((e) => e.kind === 'args').map((e) => e.args as string[]);
    expect(args).toHaveLength(2);
    expect(args[0]).toContain('--session-id');
    expect(args[1]).toContain('--resume');
    expect(args[1]![args[1]!.indexOf('--resume') + 1]).toBe(w.store.getSession(id)!.engineSessionId);
    expect((await w.api('GET', '/api/state')).json.sessions[0].status).toBe('idle');
  }, 20_000);
});

describe('the SSE stream (3b.6 1539, 1553)', () => {
  it('replays from after=<session>:<seq>, follows live, replays an unknown session from 0, and delivers new sessions', async () => {
    const w = await boot();
    const id = await w.session();
    await w.say(id, 'hello');
    await until(() => w.rows(id, 'turn_ended').length === 1);
    const all = w.store.readLog(id);

    const a = openStream(w.srv, { after: `${id}:${all.length - 2}` });
    await until(() => a.rows.length >= 2);
    expect(a.rows.slice(0, 2)).toEqual(all.slice(-2));

    const b = openStream(w.srv);
    await until(() => b.rows.length >= all.length);
    expect(b.rows.slice(0, all.length)).toEqual(all);

    const c = openStream(w.srv, { after: 'nosuch:5,garbage,x:y' });
    await until(() => c.rows.length >= all.length);
    expect(c.rows.slice(0, all.length)).toEqual(all);

    await w.say(id, 'again');
    await until(() => a.rows.some((r) => r.type === 'turn_ended' && r.seq > all.length));
    const id2 = await w.session();
    await until(() => a.rows.some((r) => r.sessionId === id2 && r.type === 'session_created'));
    const seqs = a.rows.filter((r) => r.sessionId === id).map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
  }, 20_000);

  it('sends a ": heartbeat" comment every heartbeatMs', async () => {
    const w = await boot([], { heartbeatMs: 30 });
    const s = openStream(w.srv);
    await s.ready;
    await until(() => s.comments.length >= 2);
    expect(s.comments[0]).toBe(': heartbeat');
  });

  it('GET /api/sessions/:id/log returns { rows } after a seq', async () => {
    const w = await boot();
    const id = await w.session();
    await w.say(id, 'hi');
    await w.settled(id, 1);
    const all = w.store.readLog(id);
    expect((await w.api('GET', `/api/sessions/${id}/log`)).json).toEqual({ rows: all });
    expect((await w.api('GET', `/api/sessions/${id}/log?after=2`)).json).toEqual({ rows: all.slice(2) });
    expect((await w.api('GET', `/api/sessions/${id}/log?after=9999`)).json).toEqual({ rows: [] });
  });
});

describe('workflows, tags and the lock (3b.5 1485, 3b.6 1498, 3b.3 1554)', () => {
  it('lists project and personal workflows with diagnostics, and serves the tag catalogue', async () => {
    const w = await boot();
    const proj = path.join(w.cwd, '.reins', 'workflows');
    const mine = path.join(w.dir, 'workflows');
    fs.mkdirSync(proj, { recursive: true });
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(proj, 'good.reins.md'), GOOD);
    fs.writeFileSync(path.join(proj, 'bad.reins.md'), NO_BUDGET);
    fs.writeFileSync(path.join(proj, 'notes.txt'), 'ignored');
    fs.writeFileSync(path.join(mine, 'mine.reins.md'), GOOD);
    const r = await w.api('GET', `/api/workflows?cwd=${encodeURIComponent(w.cwd)}`);
    expect(r.status).toBe(200);
    const list = r.json.workflows as Array<{ path: string; name: string; scope: string; diagnostics: Array<{ severity: string }> }>;
    expect(list.map((x) => [x.name, x.scope])).toEqual([['bad', 'project'], ['good', 'project'], ['mine', 'user']]);
    expect(list[0]!.path).toBe(path.join(proj, 'bad.reins.md'));
    expect(list[0]!.diagnostics.some((d) => d.severity === 'error')).toBe(true);
    expect(list[1]!.diagnostics.some((d) => d.severity === 'error')).toBe(false);
    expect((await w.api('GET', '/api/workflows')).status).toBe(400);
    expect((await w.api('GET', '/api/workflows?cwd=rel')).status).toBe(400);
    const none = await w.api('GET', `/api/workflows?cwd=${encodeURIComponent(path.join(w.cwd, 'empty'))}`);
    expect(none.json.workflows.map((x: { name: string }) => x.name)).toEqual(['mine']);

    const t = await w.api('GET', '/api/tags');
    expect(t.json).toEqual({ tags: JSON.parse(JSON.stringify(tagCatalogue())) });
    expect(t.json.tags.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(['gate', 'repeat', 'verify', 'guard', 'read-only']));
  });

  it('start runs recover on the log it finds: the open question is closed and the session is idle again', async () => {
    const dir = tmpDir();
    const store = openStore(':memory:');
    store.createSession({ id: 's1', cwd: dir, engine: 'claude' });
    store.appendLog('s1', { type: 'question', data: { id: 'q', kind: 'tool', prompt: 'p' } });
    store.appendLog('s1', { type: 'status', data: { status: 'waiting' } });
    const srv = await startServer({ store, dir, probe: async () => PROBE, makeEngine: () => { throw new Error('never opened'); } });
    expect(store.readLog('s1').map((r) => r.type)).toEqual(['question', 'status', 'question_closed', 'status']);
    expect((await request(srv, 'GET', '/api/state')).json.sessions[0].status).toBe('idle');
    await srv.close();
    store.close();
  });

  it('a second instance is refused before recover writes anything, and it does not release the first one\'s lock', async () => {
    const dir = tmpDir();
    const store = openStore(':memory:');
    store.createSession({ id: 's1', cwd: dir, engine: 'claude' });
    store.appendLog('s1', { type: 'question', data: { id: 'q', kind: 'tool', prompt: 'p' } });
    const lockFile = path.join(dir, 'serve.lock');
    expect(takeLock(lockFile, { pid: process.pid, port: 4242, token: 'tok' })).toEqual({ ok: true });
    const err: any = await startServer({
      store, dir, lockFile, probe: async () => PROBE,
      makeEngine: () => { throw new Error('never opened'); },
    }).then(() => undefined, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.running).toEqual({ pid: process.pid, port: 4242, token: 'tok' });
    expect(store.readLog('s1').map((r) => r.type)).toEqual(['question']);
    expect(fs.existsSync(lockFile)).toBe(true);
    store.close();
  });
});
