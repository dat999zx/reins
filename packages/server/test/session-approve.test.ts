// M7 T2: the session seam of `approve: "fence"`: the three askTool sites and the playbook trust question ask the rule table, and an automatic answer row says `by: 'fence'`.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolRequest } from '@reins/core';
import { DENY_MCP } from '../src/approve-fence.js';
import type { Question } from '../src/drive.js';
import { openSession, type SessionDeps } from '../src/session.js';
import { openStore } from '../src/store.js';
import { testEngine, type TestTurn } from './test-engine.js';
import { usePack } from './pack-helper.js';

usePack();

const tmps: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-apv-')); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

async function until(f: () => boolean) {
  for (let i = 0; i < 600 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(f(), 'the condition was not met in time').toBe(true);
}

function setup(script: TestTurn[] = [], o: { approve?: 'fence'; autoApprove?: boolean } = {}) {
  const store = openStore(':memory:');
  const t = testEngine(script);
  const dir = tmp();
  const cwd = tmp();
  const state = { fenced: true, words: undefined as string | undefined, approve: o.approve as 'fence' | undefined };
  const parallel: NonNullable<SessionDeps['parallel']> = { fenced: () => state.fenced, capWords: () => state.words, approve: () => state.approve };
  let onApprove: ((r: ToolRequest) => Promise<{ behavior: string; message?: string }>) | undefined;
  const makeEngine: SessionDeps['makeEngine'] = (opts) => { onApprove = opts.onApprove as typeof onApprove; return t.makeEngine(opts); };
  const deps = { store, makeEngine, folderTrust: t.folderTrust, dir, parallel };
  const row = store.createSession({ id: 's1', cwd, engine: 'claude-code' });
  if (o.autoApprove) store.updateSession('s1', { autoApprove: true });
  const s = openSession(deps, row, true);
  const log = () => store.readLog('s1');
  const rows = (type: string) => log().filter((r) => r.type === type);
  const data = (type: string) => rows(type).map((r) => r.data as any);
  const open = (kind: Question['kind']) => {
    const l = log();
    return l.filter((r) => r.type === 'question').map((r) => r.data as Question)
      .filter((q) => q.kind === kind && !l.some((x) => (x.type === 'answer' || x.type === 'question_closed') && (x.data as any).questionId === q.id));
  };
  const question = async (kind: Question['kind']) => { await until(() => open(kind).length > 0); return open(kind)[0]!; };
  return { store, t, s, state, cwd, dir, log, rows, data, open, question, ask: (r: ToolRequest) => onApprove!(r) };
}

const FRONT = '---\nreins: 1\nname: w\nbudget: { turns: 10, minutes: 10 }\nalways: []\n---\n\n';
const put = (dir: string, name: string, text: string) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, text);
  return f;
};
const sh = (command: string) => ({ tool: 'Bash', input: { command }, approve: true });

describe('the main engine', () => {
  it('answers a safe shape y with by: fence, and leaves a git push a card', async () => {
    const x = setup([{ tools: [sh('npm run lint'), sh('git push origin main')] }], { approve: 'fence' });
    x.s.message('go');
    const q = await x.question('tool');
    expect(q.detail).toContain('git push origin main');
    const answers = x.data('answer');
    expect(answers).toEqual([{ questionId: expect.any(String), answer: 'y', by: 'fence' }]);
    expect(x.data('question').filter((d) => d.kind === 'tool')).toHaveLength(2);
    expect(x.s.status()).toBe('waiting');
    x.s.answer(q.id, 'n');
    await x.s.idle();
    expect(x.t.decisions).toEqual([{ behavior: 'allow' }, { behavior: 'deny', message: 'The user said no.' }]);
  });

  it('denies an mcp call with the words and by: fence', async () => {
    const x = setup([{ tools: [{ tool: 'mcp__knowl__knowl_query', input: { query: 'x' }, approve: true }] }], { approve: 'fence' });
    x.s.message('go');
    await x.s.idle();
    expect(x.data('answer')).toEqual([{ questionId: expect.any(String), answer: DENY_MCP, by: 'fence' }]);
    expect(x.t.decisions).toEqual([{ behavior: 'deny', message: 'The user said no: MCP tools are off in this fenced parallel run; carry on with the plan and the code.' }]);
  });

  it('a request with a reason stays a card', async () => {
    const x = setup([{ hold: true }], { approve: 'fence' });
    x.s.message('go');
    await until(() => x.t.turns.length === 1);
    const asked = x.ask({ tool: 'Read', input: { file_path: path.join(x.cwd, 'a.ts') }, reason: 'outside the project (x)' });
    const q = await x.question('tool');
    expect(x.rows('answer')).toEqual([]);
    x.s.answer(q.id, 'n');
    await expect(asked).resolves.toMatchObject({ behavior: 'deny' });
    x.t.release();
    await x.s.idle();
  });

  it('without approve, a safe shape is a card and no row says by', async () => {
    const x = setup([{ tools: [sh('npm run lint')] }]);
    x.s.message('go');
    const q = await x.question('tool');
    expect(x.rows('answer')).toEqual([]);
    x.s.answer(q.id, 'y');
    await x.s.idle();
    expect(JSON.stringify(x.log())).not.toContain('"by"');
  });

  it('autoApprove without approve keeps the two-key answer row', async () => {
    const x = setup([{ tools: [sh('npm run lint')] }], { autoApprove: true });
    x.s.message('go');
    await x.s.idle();
    const q = x.data('question').find((d) => d.kind === 'tool');
    expect(x.data('answer')).toEqual([{ questionId: q.id, answer: 'y' }]);
  });
});

describe('a subagent', () => {
  const sub = (x: ReturnType<typeof setup>) => expect(x.s.runFile(put(x.cwd, 'w.reins.md', `${FRONT}## subagent one\n> Look.\n`))).toEqual({ ok: true });

  it('is answered by the fence too', async () => {
    const x = setup([{ tools: [sh('npm run lint')], text: 'a' }], { approve: 'fence' });
    sub(x);
    await x.s.idle();
    expect(x.t.decisions).toEqual([{ behavior: 'allow' }]);
    expect(x.data('answer').filter((d) => d.by === 'fence').length).toBeGreaterThan(0);
  });

  it('is denied when the subagentApprovals setting says deny: the setting wins', async () => {
    const x = setup([{ tools: [sh('npm run lint')], text: 'a' }], { approve: 'fence' });
    x.store.putSetting('subagentApprovals', 'deny');
    sub(x);
    await x.s.idle();
    expect(x.t.decisions).toEqual([{ behavior: 'deny', message: 'Denied by Reins: subagent approvals are set to deny. Carry on without this tool.' }]);
  });
});

describe('the playbook trust question', () => {
  it('a playbook that trusts only npm test is answered by the fence', async () => {
    const x = setup([{ text: 'a' }], { approve: 'fence' });
    expect(x.s.runFile(put(x.cwd, 'w.reins.md', `${FRONT}## subagent one\n> Look.\n`))).toEqual({ ok: true });
    await x.s.idle();
    const trust = x.data('question').find((d) => d.kind === 'trust');
    expect(x.data('answer')).toContainEqual({ questionId: trust.id, answer: 'y', by: 'fence' });
    expect(x.open('trust')).toEqual([]);
  });

  it('a playbook whose test is curl keeps the question open', async () => {
    const x = setup([{ text: 'a' }], { approve: 'fence' });
    expect(x.s.runFile(put(x.cwd, 'w.reins.md', `---\nreins: 1\nname: w\nbudget: { turns: 10, minutes: 10 }\nalways: []\ntest: curl http://x\n---\n\n## subagent one\n> Look.\n`))).toEqual({ ok: true });
    const q = await x.question('trust');
    expect(q.detail).toContain('curl http://x');
    expect(x.rows('answer')).toEqual([]);
    x.s.answer(q.id, 'n');
    await x.s.idle();
  });
});
