import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeEngine, Run, parseWorkflow } from '@reins/core';
import { driveRun } from '../src/drive.js';
import { boot, cleanup, tmpDir, type World } from './http-helpers.js';

afterEach(cleanup);

const TEXT = '---\nreins: 1\nname: demo\nbudget: { turns: 10, minutes: 30 }\nalways: []\n---\n\n## phase plan\n> Plan the change.\n\n## phase build\n> Make the change.\n';

function call(srv: { port: number; token: string }, method: 'GET' | 'PUT' | 'POST', url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: srv.port, path: url, method, agent: false,
      headers: { authorization: `Bearer ${srv.token}`, ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function world() {
  const w: World = await boot();
  const id = await w.session();
  const base = `/api/sessions/${id}`;
  const get = (p: string) => call(w.srv, 'GET', `${base}/workflow?path=${encodeURIComponent(p)}`);
  const put = (p: string, text: string, create?: boolean) => call(w.srv, 'PUT', `${base}/workflow`, { path: p, text, ...(create !== undefined ? { create } : {}) });
  const preview = (p: string, text: string, stepId?: string) => call(w.srv, 'POST', `${base}/preview`, { path: p, text, ...(stepId ? { stepId } : {}) });
  const project = path.join(w.cwd, '.reins', 'workflows');
  const user = path.join(w.dir, 'workflows');
  return { w, get, put, preview, project, user };
}

function tryLink(target: string, at: string, type: 'file' | 'junction'): boolean {
  try {
    fs.symlinkSync(target, at, type);
    return true;
  } catch {
    return false;
  }
}
const link = (target: string, at: string, type: 'file' | 'dir') => tryLink(target, at, type === 'dir' ? 'junction' : 'file');
// Windows without symlink rights still makes junctions; lstat sees them as links all the same.
const fileLink = (target: string, at: string) => tryLink(target, at, 'file') || tryLink(target, at, 'junction');

describe('workflow GET/PUT (3c.9 path rule)', () => {
  it('PUT creates the folder in both allowed places; GET reads it back with diagnostics', async () => {
    const x = await world();
    for (const dir of [x.project, x.user]) {
      const file = path.join(dir, 'a.reins.md');
      expect(fs.existsSync(dir)).toBe(false);
      const r = await x.put(file, TEXT);
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ diagnostics: [] });
      expect(fs.readFileSync(file, 'utf8')).toBe(TEXT);
      const g = await x.get(file);
      expect(g.status).toBe(200);
      expect(g.json).toEqual({ path: file, text: TEXT, diagnostics: [] });
    }
  });

  it('a relative path is relative to the session folder', async () => {
    const x = await world();
    expect((await x.put('.reins/workflows/rel.reins.md', TEXT)).status).toBe(200);
    expect(fs.existsSync(path.join(x.project, 'rel.reins.md'))).toBe(true);
    expect((await x.get('.reins/workflows/rel.reins.md')).status).toBe(200);
  });

  it('PUT writes even when there are errors, and says so', async () => {
    const x = await world();
    const r = await x.put(path.join(x.project, 'bad.reins.md'), 'not a workflow\n');
    expect(r.status).toBe(200);
    expect(r.json.diagnostics.some((d: any) => d.severity === 'error')).toBe(true);
    expect(fs.readFileSync(path.join(x.project, 'bad.reins.md'), 'utf8')).toBe('not a workflow\n');
  });

  it('GET of a missing file, or with no workflows folder, is 404', async () => {
    const x = await world();
    expect((await x.get(path.join(x.project, 'none.reins.md'))).status).toBe(404);
    fs.mkdirSync(x.project, { recursive: true });
    expect((await x.get(path.join(x.project, 'none.reins.md'))).status).toBe(404);
  });

  it.each([
    ['a subfolder', (x: Awaited<ReturnType<typeof world>>) => path.join(x.project, 'sub', 'a.reins.md')],
    ['a name that is not .reins.md', (x: Awaited<ReturnType<typeof world>>) => path.join(x.project, 'a.md')],
    ['a colon in the name', (x: Awaited<ReturnType<typeof world>>) => path.join(x.project, 'a:b.reins.md')],
    ['..', (x: Awaited<ReturnType<typeof world>>) => path.join(x.project, '..', '..', 'a.reins.md')],
    ['the session folder itself', (x: Awaited<ReturnType<typeof world>>) => path.join(x.w.cwd, 'a.reins.md')],
    ['a NUL byte', (x: Awaited<ReturnType<typeof world>>) => path.join(x.project, 'a\0.reins.md')],
    ['a path in another project', () => path.join(tmpDir(), '.reins', 'workflows', 'a.reins.md')],
  ])('400 for %s, on GET, PUT and preview, and nothing is written', async (_n, mk) => {
    const x = await world();
    const p = mk(x);
    expect((await x.get(p)).status).toBe(400);
    const r = await x.put(p, TEXT);
    expect(r.status).toBe(400);
    expect(typeof r.json.error).toBe('string');
    expect((await x.preview(p, TEXT)).status).toBe(400);
    expect(fs.existsSync(p)).toBe(false);
    expect(fs.existsSync(path.join(x.w.cwd, '.reins'))).toBe(false);
  });

  it('a symlinked file pointing outside is 400 and the target is untouched', async (ctx) => {
    const x = await world();
    const out = tmpDir();
    fs.writeFileSync(path.join(out, 'x.reins.md'), 'OUTSIDE');
    fs.mkdirSync(x.project, { recursive: true });
    if (!fileLink(path.join(out, 'x.reins.md'), path.join(x.project, 'l.reins.md'))) return ctx.skip();
    expect((await x.get(path.join(x.project, 'l.reins.md'))).status).toBe(400);
    expect((await x.put(path.join(x.project, 'l.reins.md'), TEXT)).status).toBe(400);
    expect((await x.put(path.join(x.project, 'l.reins.md'), TEXT, true)).status).toBe(400);
    expect(fs.readFileSync(path.join(out, 'x.reins.md'), 'utf8')).toBe('OUTSIDE');
  });

  it('a dangling symlinked file: PUT is 400 and creates nothing at its target', async (ctx) => {
    const x = await world();
    const out = tmpDir();
    fs.mkdirSync(x.project, { recursive: true });
    if (!fileLink(path.join(out, 'made.reins.md'), path.join(x.project, 'd.reins.md'))) return ctx.skip();
    expect((await x.put(path.join(x.project, 'd.reins.md'), TEXT)).status).toBe(400);
    expect((await x.put(path.join(x.project, 'd.reins.md'), TEXT, true)).status).toBe(400);
    expect((await x.get(path.join(x.project, 'd.reins.md'))).status).toBe(400);
    expect(fs.existsSync(path.join(out, 'made.reins.md'))).toBe(false);
  });

  it('a symlinked .reins folder is 400 before anything is created behind it', async (ctx) => {
    const x = await world();
    const out = tmpDir();
    if (!link(out, path.join(x.w.cwd, '.reins'), 'dir')) return ctx.skip();
    expect((await x.put(path.join(x.project, 'a.reins.md'), TEXT)).status).toBe(400);
    expect((await x.get(path.join(x.project, 'a.reins.md'))).status).toBe(400);
    expect((await x.preview(path.join(x.project, 'a.reins.md'), TEXT)).status).toBe(400);
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it('a symlinked workflows folder inside .reins is 400 too', async (ctx) => {
    const x = await world();
    const out = tmpDir();
    fs.mkdirSync(path.join(x.w.cwd, '.reins'));
    if (!link(out, x.project, 'dir')) return ctx.skip();
    expect((await x.put(path.join(x.project, 'a.reins.md'), TEXT)).status).toBe(400);
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it('a dangling .reins/workflows link makes the mkdir fail: 400', async (ctx) => {
    const x = await world();
    fs.mkdirSync(path.join(x.w.cwd, '.reins'));
    if (!link(path.join(tmpDir(), 'nowhere'), x.project, 'dir')) return ctx.skip();
    expect((await x.put(path.join(x.project, 'a.reins.md'), TEXT)).status).toBe(400);
  });

  it('create: true on an existing file is 409 and leaves it unchanged; without it PUT overwrites', async () => {
    const x = await world();
    const file = path.join(x.project, 'a.reins.md');
    expect((await x.put(file, TEXT, true)).status).toBe(200);
    const r = await x.put(file, 'other', true);
    expect(r.status).toBe(409);
    expect(typeof r.json.error).toBe('string');
    expect(fs.readFileSync(file, 'utf8')).toBe(TEXT);
    expect((await x.put(file, 'other')).status).toBe(200);
    expect(fs.readFileSync(file, 'utf8')).toBe('other');
  });

  it('bad bodies are 400', async () => {
    const x = await world();
    const file = path.join(x.project, 'a.reins.md');
    expect((await x.put(file, 5 as any)).status).toBe(400);
    expect((await x.put(1 as any, TEXT)).status).toBe(400);
    expect((await x.put(file, TEXT, 'yes' as any)).status).toBe(400);
    expect((await call(x.w.srv, 'GET', `/api/sessions/${(await x.w.api('GET', '/api/state')).json.sessions[0].id}/workflow`)).status).toBe(400);
    expect((await call(x.w.srv, 'GET', '/api/sessions/nope/workflow?path=a')).status).toBe(404);
  });
});

const PREVIEW = [
  '---', 'reins: 1', 'name: demo', 'budget: { turns: 10, minutes: 30 }', 'always:', '  - Keep it small.', '---', '',
  '## phase plan', 'mode: read-only', 'note: Be brief.', '> Plan the change.', '',
  '## phase build', '> Make the change.', '',
  '## repeat', 'until: `npm test` passes', 'max: 2', '', '### run `npm test`', '', '### phase fix', '> Fix it.', '',
  '## if tests pass', '', '### phase yes', '> Y.', '', '### else', '', '### phase no', '> N.', '',
].join('\n');

describe('preview (3c.9)', () => {
  it('returns steps with depth (kids, then else) and writes nothing', async () => {
    const x = await world();
    const before = fs.readdirSync(x.w.cwd, { recursive: true }).sort();
    const r = await x.preview(path.join(x.project, 'demo.reins.md'), PREVIEW);
    expect(r.status).toBe(200);
    expect(r.json.diagnostics.filter((d: any) => d.severity === 'error')).toEqual([]);
    const depths = r.json.steps.map((s: any) => [s.kind, s.depth]);
    expect(depths).toEqual([['phase', 0], ['phase', 0], ['repeat', 0], ['run', 1], ['phase', 1], ['if', 0], ['phase', 1], ['phase', 1]]);
    expect(r.json.steps[0]).toEqual(expect.objectContaining({ kind: 'phase', title: 'plan', depth: 0 }));
    expect(r.json.turn).toBeUndefined();
    expect(fs.readdirSync(x.w.cwd, { recursive: true }).sort()).toEqual(before);
    expect(fs.existsSync(path.join(x.w.cwd, '.reins'))).toBe(false);
  });

  it('the turn equals what a real Run sends for that step', async () => {
    const x = await world();
    const text = PREVIEW.split('## repeat')[0]!;
    const file = path.join(x.project, 'demo.reins.md');
    const steps = (await x.preview(file, text)).json.steps as Array<{ id: string }>;
    expect(steps).toHaveLength(2);

    const engine = new FakeEngine();
    const run = new Run({ workflow: parseWorkflow(text).workflow!, engine });
    await driveRun(run, { ask: async () => null, say: () => {}, write: () => {} }, () => {});
    expect(engine.receivedTexts).toHaveLength(2);

    for (const [i, s] of steps.entries()) {
      const r = await x.preview(file, text, s.id);
      expect(r.status).toBe(200);
      expect(r.json.turn).toBe(engine.receivedTexts[i]);
    }
    expect(engine.receivedTexts[0]).toContain('Step is read-only');
    expect(engine.receivedTexts[0]).toContain('- Keep it small.');
  });

  it('no turn when there are errors, for an unknown step, or for a step that is not a turn', async () => {
    const x = await world();
    const file = path.join(x.project, 'demo.reins.md');
    const ok = (await x.preview(file, PREVIEW)).json.steps as Array<{ id: string; kind: string }>;
    expect((await x.preview(file, PREVIEW, 'nope')).json.turn).toBeUndefined();
    const run = ok.find((s) => s.kind === 'run')!;
    expect((await x.preview(file, PREVIEW, run.id)).json.turn).toBeUndefined();
    const broken = await x.preview(file, PREVIEW + '\n## nonsense-kind\n', ok[0]!.id);
    expect(broken.status).toBe(200);
    expect(broken.json.diagnostics.some((d: any) => d.severity === 'error')).toBe(true);
    expect(broken.json.turn).toBeUndefined();
  });

  it('400 for a bad path or body; the file need not exist', async () => {
    const x = await world();
    expect((await x.preview(path.join(x.project, 'sub', 'a.reins.md'), TEXT)).status).toBe(400);
    expect((await call(x.w.srv, 'POST', `/api/sessions/${(await x.w.api('GET', '/api/state')).json.sessions[0].id}/preview`, { path: path.join(x.project, 'a.reins.md') })).status).toBe(400);
    expect((await x.preview(path.join(x.project, 'a.reins.md'), TEXT)).status).toBe(200);
  });
});
