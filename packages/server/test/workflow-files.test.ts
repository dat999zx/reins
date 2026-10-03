import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeEngine, Run, parseWorkflow, printCond } from '@reins/core';
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
  const previewModel = (p: string, workflow: unknown, stepId?: string) => call(w.srv, 'POST', `${base}/preview`, { path: p, workflow, ...(stepId ? { stepId } : {}) });
  const project = path.join(w.cwd, '.reins', 'workflows');
  const user = path.join(w.dir, 'workflows');
  return { w, base, get, put, preview, previewModel, project, user };
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

  it('returns the frontmatter name, and omits it when the text does not parse', async () => {
    const x = await world();
    const file = path.join(x.project, 'other-file-name.reins.md');
    expect((await x.preview(file, PREVIEW)).json.name).toBe('demo');
    const bad = await x.preview(file, 'just words, no frontmatter');
    expect(bad.status).toBe(200);
    expect('name' in bad.json).toBe(false);
  });

  it('400 for a bad path or body; the file need not exist', async () => {
    const x = await world();
    expect((await x.preview(path.join(x.project, 'sub', 'a.reins.md'), TEXT)).status).toBe(400);
    expect((await call(x.w.srv, 'POST', `/api/sessions/${(await x.w.api('GET', '/api/state')).json.sessions[0].id}/preview`, { path: path.join(x.project, 'a.reins.md') })).status).toBe(400);
    expect((await x.preview(path.join(x.project, 'a.reins.md'), TEXT)).status).toBe(200);
  });

  it('returns the raw model, cond on repeat/if, and reformats false for a clean file', async () => {
    const x = await world();
    const file = path.join(x.project, 'demo.reins.md');
    const r = await x.preview(file, PREVIEW);
    expect(r.status).toBe(200);
    const flat = (steps: any[]): any[] => steps.flatMap((s) => [s, ...flat(s.kids ?? []), ...flat(s.else ?? [])]);
    expect(flat(r.json.workflow.steps).map((s) => s.id)).toEqual(r.json.steps.map((s: any) => s.id));
    const model = parseWorkflow(PREVIEW).workflow!;
    const conds = Object.fromEntries(flat(model.steps).filter((s) => s.cond).map((s) => [s.id, printCond(s.cond!)]));
    expect(Object.keys(conds)).toHaveLength(2);
    for (const s of r.json.steps) {
      if (s.kind === 'repeat' || s.kind === 'if') expect(s.cond).toBe(conds[s.id]);
      else expect('cond' in s).toBe(false);
    }
    expect(r.json.reformats).toBe(false);
    expect((await x.preview(file, TEXT)).json.reformats).toBe(false);
    expect('text' in r.json).toBe(false);
  });

  it('reformats is true when printing drops a line, false for blank lines and trailing spaces only', async () => {
    const x = await world();
    const file = path.join(x.project, 'demo.reins.md');
    const note = TEXT.replace('## phase plan\n', '## phase plan\njust a note\n');
    expect((await x.preview(file, note)).json.reformats).toBe(true);
    const before = TEXT.replace('---\n\n## phase plan', '---\nstray line\n\n## phase plan');
    expect((await x.preview(file, before)).json.reformats).toBe(true);
    expect((await x.preview(file, TEXT + '\n')).json.reformats).toBe(false);
    expect((await x.preview(file, TEXT.replace('## phase plan\n', '## phase plan  \n'))).json.reformats).toBe(false);
    expect((await x.preview(file, TEXT + '   \n')).json.reformats).toBe(false);
  });

  it('round trip over the examples: text -> model -> same text and diagnostics', async () => {
    const x = await world();
    const dir = fileURLToPath(new URL('../../../examples/', import.meta.url));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.reins.md'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');
      const file = path.join(x.project, f);
      const first = await x.preview(file, text);
      expect(first.status).toBe(200);
      const second = await x.previewModel(file, first.json.workflow);
      expect(second.status).toBe(200);
      expect(second.json.text).toBe(text);
      expect(second.json.diagnostics).toEqual(first.json.diagnostics);
    }
  });

  it('an edit through the model comes back as printed text', async () => {
    const x = await world();
    const file = path.join(x.project, 'demo.reins.md');
    const w = (await x.preview(file, TEXT)).json.workflow;
    w.steps[0].links.push({ kind: 'next', to: 'build' });
    const r = await x.previewModel(file, w);
    expect(r.status).toBe(200);
    expect(r.json.text).toContain('\n## phase plan\nnext: build\n> Plan the change.');
    expect(r.json.diagnostics.filter((d: any) => d.severity === 'error')).toEqual([]);
    expect(r.json.steps.map((s: any) => s.id)).toEqual(['plan', 'build']);
  });

  it('with validation errors the model is still returned; without frontmatter it is not', async () => {
    const x = await world();
    const file = path.join(x.project, 'demo.reins.md');
    const bad = await x.preview(file, TEXT.replace('> Plan the change.', 'next: nowhere\n> Plan the change.'));
    expect(bad.json.diagnostics.some((d: any) => d.severity === 'error')).toBe(true);
    expect(bad.json.workflow.steps).toHaveLength(2);
    const none = await x.preview(file, 'just words, no frontmatter');
    expect('workflow' in none.json).toBe(false);
    expect('name' in none.json).toBe(false);
    expect('reformats' in none.json).toBe(false);
  });

  it('400 for a model request that is malformed; the existing text request is unchanged', async () => {
    const x = await world();
    const file = path.join(x.project, 'demo.reins.md');
    const model = (await x.preview(file, TEXT)).json.workflow;
    const send = (b: Record<string, unknown>) => call(x.w.srv, 'POST', `${x.base}/preview`, { path: file, ...b });
    expect((await send({ text: TEXT, workflow: model })).status).toBe(400);
    expect((await send({ workflow: 'x' })).status).toBe(400);
    expect((await send({ workflow: [] })).status).toBe(400);
    expect((await send({ workflow: { ...model, steps: 'x' } })).status).toBe(400);
    expect((await send({ workflow: { ...model, budget: null } })).status).toBe(400);
    const broken = await send({ workflow: { ...model, steps: [{ id: 'a', kind: 'phase', links: 5, attrs: {} }] } });
    expect(broken.status).toBe(400);
    expect(broken.json.error).toBe('The workflow model is malformed.');
    expect((await send({ workflow: model, stepId: 5 })).status).toBe(400);
    expect((await send({ text: TEXT, stepId: 5 })).status).toBe(400);
    expect((await send({ workflow: model })).status).toBe(200);
  });

  it('a model request writes nothing to disk', async () => {
    const x = await world();
    const file = path.join(x.project, 'demo.reins.md');
    const model = (await x.preview(file, TEXT)).json.workflow;
    const before = fs.readdirSync(x.w.cwd, { recursive: true }).sort();
    expect((await x.previewModel(file, model)).status).toBe(200);
    expect(fs.readdirSync(x.w.cwd, { recursive: true }).sort()).toEqual(before);
    expect(fs.existsSync(path.join(x.w.cwd, '.reins'))).toBe(false);
  });});
