import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { printWorkflow, type EngineProbe, type Workflow } from '@reins/core';
import { sameToken } from './token.js';
import { releaseLock, runningLock, takeLock } from './lock.js';
import type { Catalog, CatalogModel } from './catalog.js';
import { CATALOG_DIR, checkEnvFrom, consentFrom, defaultProviderOf, folderTrustFrom, hostSend, keyEnvNames, liveListSource, providerOrigin, providerViews, startMods, type ProviderView } from './engines.js';
import { addCustom, deleteKey, editMod, installMods, listMods, providerStatus, putKey, reinstallMod, removeMod, revokeConsent, setConsent, setEnabled, testConnection, type ConsentStore } from './mods/actions.js';
import { childEnv, type Redactor } from './secrets.js';
import { createLiveModels } from './live-models.js';
import { listModels, parseModel, type PickerModel } from './models.js';
import type { Mods, SendWithKey } from './mods/types.js';
import type { ProviderStatus } from './run-checks.js';
import { recover } from './recover.js';
import { loadWorkflow } from './run-cli.js';
import { openSession, under, type Ack, type DescribeEffort, type DescribeModel, type MakeEngine, type Session, type SessionDeps } from './session.js';
import { contextSize, priceFor, readSetting, switchEstimate } from './settings.js';
import type { LogRow, Store } from './store.js';
import { tagCatalogue, type Tag } from './tags.js';
import { previewWorkflow, readWorkflow, writeWorkflow } from './workflow-files.js';

export interface ServerOptions {
  store: Store;
  makeEngine: MakeEngine;
  dir: string;
  /** Probes one installed provider, by id. */
  probe: (provider: string) => Promise<EngineProbe>;
  port?: number;
  lockFile?: string;
  heartbeatMs?: number;
  appDir?: string;
  pickFolder?: (signal: AbortSignal) => Promise<string | null>;
  catalog?: Catalog;
  /** The loaded mods. None: the bundled ones are loaded here (tests that build a server by hand). */
  mods?: Mods;
  /** Where the providers the settings can install from live (`<id>/mod.json`). None: the catalog that ships with Reins. */
  catalogDir?: string;
  /** The env workflow commands start from; the server removes the installed key names and REINS_* from it, whatever it is given. None: this process's. */
  env?: NodeJS.ProcessEnv;
  /** Hides secrets in what the API shows (the probe answers) and in streamed command output, and refuses workflow text that holds one. None: nothing is hidden. */
  redactor?: Redactor;
  /** The only way the live model lists and Test connection send (spec 7.8). None: the host's own `send`, which asks the store for consent. */
  send?: SendWithKey;
  /** The consent seam (`SessionDeps.consent`): undefined for a provider means its consent is recorded. None: the store decides (`consentFrom`). */
  consent?: SessionDeps['consent'];
  /** How long Test connection waits for the provider, in ms. None: 8 seconds. */
  testTimeoutMs?: number;
}
export interface Server { port: number; token: string; url: string; close(): Promise<void> }

/** A provider's models in the picker, with what it needs: `installed` (a key is set), `needs-key`, or `keyless`. `consent`: a yes is recorded for its current address (only for a provider Reins sends to). */
export interface ProviderGroup { id: string; label: string; status: 'installed' | 'needs-key' | 'keyless'; consent?: 'granted' | 'needed'; models: PickerModel[] }
/** What the picker needs of one session (spec 9.1, 9.3, 9.4): its provider's status, `provider:model`, and where it may switch. */
export interface SessionProviderState {
  provider: ProviderStatus;
  composite: string;
  /** Every installed provider: `allowed`, or why the session cannot move there. */
  switchTo: Array<{ provider: string; allowed: boolean; why?: string }>;
}

const MAX_BODY = 1024 * 1024;
type Reply = { status: number; body: unknown };
interface Body {
  text?: unknown; tags?: unknown; kind?: unknown; questionId?: unknown; answer?: unknown; autoApprove?: unknown;
  title?: unknown; path?: unknown; create?: unknown; stepId?: unknown; runId?: unknown; cwd?: unknown; engine?: unknown; model?: unknown; effort?: unknown;
  state?: unknown; workflow?: unknown;
}
const MAX_EDITOR_STATE = 64 * 1024;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const editorKey = (cwd: unknown): string | undefined => {
  if (!str(cwd) || cwd.includes('\0') || !path.isAbsolute(cwd)) return undefined;
  const k = path.resolve(cwd);
  return process.platform === 'win32' ? k.toLowerCase() : k;
};

const ok = (body: unknown = {}): Reply => ({ status: 200, body });
const fail = (status: number, error: string): Reply => ({ status, body: { error } });
const fromAck = (a: Ack): Reply =>
  a.ok ? ok() : { status: a.code, body: { error: a.error, ...(a.text !== undefined ? { text: a.text } : {}), ...(a.diagnostics ? { diagnostics: a.diagnostics } : {}) } };
const str = (v: unknown): v is string => typeof v === 'string';
const isTags = (v: unknown): v is Tag[] =>
  Array.isArray(v) && v.every((t) => typeof t === 'object' && t !== null && str(t.tag) && (t.arg === undefined || str(t.arg)));

interface Ctx { store: Store; describe: DescribeModel; describeEffort: DescribeEffort; installed: (provider: string) => boolean }
const actions: Record<string, (s: Session, b: Body, ctx: Ctx) => Reply | Promise<Reply>> = {
  message: (s, b) => {
    const tags = b.tags ?? [];
    if (!str(b.text) || !b.text.trim()) return fail(400, 'text must be a non-empty string.');
    if (!isTags(tags)) return fail(400, 'tags must be a list of { tag, arg? } with string values.');
    return fromAck(s.message(b.text, tags));
  },
  card: (s, b) => {
    if (b.kind !== 'steer' && b.kind !== 'now' && b.kind !== 'stop') return fail(400, "kind must be 'steer', 'now' or 'stop'.");
    if (!str(b.text) || (!b.text.trim() && b.kind !== 'stop')) return fail(400, 'text must be a non-empty string.');
    return fromAck(s.card(b.text, b.kind));
  },
  answer: (s, b) => (str(b.questionId) && str(b.answer) ? fromAck(s.answer(b.questionId, b.answer)) : fail(400, 'questionId and answer must be strings.')),
  settings: (s, b, { store, describe, describeEffort, installed }) => {
    const { autoApprove, title, model, effort } = b;
    if (autoApprove !== undefined && typeof autoApprove !== 'boolean') return fail(400, 'autoApprove must be a boolean.');
    if (title !== undefined && !str(title)) return fail(400, 'title must be a string.');
    if (model !== undefined && !str(model)) return fail(400, 'model must be a string.');
    if (str(model) && (model.length > 400 || [...model].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f))) return fail(400, 'model must be a short name with no control characters.');
    if (effort !== undefined && !str(effort)) return fail(400, 'effort must be a string.');
    const level = str(effort) ? describeEffort(s.info().engine, effort) : undefined;
    if (level && !level.listed) return fail(400, 'Unknown reasoning level.');
    let target: { estimate: number | undefined; label: string; source?: 'table' | 'catalog' } | undefined;
    let named: { provider: string; model: string } | undefined;
    if (model) {
      // `provider:model` (spec 9.2) or a bare model of the session's provider. '' is the default.
      const p = parseModel(model, s.info().engine, installed);
      if ('error' in p) return fail(400, p.error);
      named = p;
      const d = describe(p.provider, p.model, contextSize(store.readLog(s.id)));
      // The session's own current model stays selectable even when the list no longer has it. A model written with its provider is a typed id
      // (spec 9.1): it is accepted although no list has it, and shown as typed. A bare name that is in no list is still refused.
      const typed = p.model !== model.trim();
      if (!d.listed && !typed && !(p.provider === s.info().engine && p.model === s.info().model)) return fail(400, "Unknown model for this session's provider.");
      target = { estimate: d.estimate, label: d.label, ...(d.source ? { source: d.source } : {}) };
    } else if (model === '') {
      target = { estimate: undefined, label: 'the default model' };
    }
    return fromAck(s.settings({
      ...(autoApprove !== undefined ? { autoApprove } : {}), ...(title !== undefined ? { title } : {}),
      ...(model !== undefined ? { model: named ? named.model : model, ...(named ? { provider: named.provider } : {}), ...target } : {}),
      ...(str(effort) ? { effort, effortLabel: level!.label } : {}),
    }));
  },
  compress: (s) => fromAck(s.compress()),
  run: (s, b) => (str(b.path) && b.path ? fromAck(s.runFile(b.path)) : fail(400, 'path must be a non-empty string.')),
  resume: (s, b) => (str(b.runId) && b.runId ? fromAck(s.resume(b.runId)) : fail(400, 'runId must be a non-empty string.')),
  close: async (s) => { await s.close(); return ok(); },
};

function readBody(req: http.IncomingMessage): Promise<{ text: string } | { tooBig: true } | { aborted: true }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    // Over the cap the bytes are read and dropped, so the client gets its 413 instead of a reset.
    req.on('data', (c: Buffer) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => resolve(size > MAX_BODY ? { tooBig: true } : { text: Buffer.concat(chunks).toString('utf8') }));
    // A cut-off request (a truncated POST) is never acted on; the first resolve wins, so a normal 'close' after 'end' changes nothing.
    req.on('close', () => resolve({ aborted: true }));
    req.on('error', () => resolve({ aborted: true }));
  });
}

async function parse(req: http.IncomingMessage): Promise<{ b: Body } | { fail: Reply }> {
  const r = await readBody(req);
  if ('tooBig' in r) return { fail: fail(413, 'The body is larger than 1 MB.') };
  if ('aborted' in r) return { fail: fail(400, 'The request was cut off.') };
  let v: unknown;
  try {
    v = r.text ? JSON.parse(r.text) : {};
  } catch {
    return { fail: fail(400, 'The body is not valid JSON.') };
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { fail: fail(400, 'The body must be a JSON object.') };
  return { b: v as Body };
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
};

function serveStatic(appDir: string, pathname: string, res: http.ServerResponse) {
  try {
    const p = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    if (p.includes('\0')) return send(res, fail(404, 'Not found.'));
    const file = path.resolve(appDir, '.' + p);
    if (!under(file, path.resolve(appDir)) || !fs.statSync(file).isFile()) return send(res, fail(404, 'Not found.'));
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    send(res, fail(404, 'Not found.'));
  }
}

function send(res: http.ServerResponse, r: Reply) {
  res.writeHead(r.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(r.body));
}

export async function startServer(o: ServerOptions): Promise<Server> {
  const ownMods = o.mods ? undefined : await startMods({ dir: o.dir, env: {} });
  const mods = (o.mods ?? ownMods)!;
  // Read again after every change in Settings > Providers (`afterModChange`); everything below reads the variable when it runs.
  let providers = providerViews(mods);
  const catalog = o.catalog;
  const catalogOf = (p: ProviderView): CatalogModel[] => (p.catalog ? catalog?.models(p.catalog) ?? [] : []);
  // The live lists (spec 7.2) go through the host's `send` only, and a keyed provider's only once its consent is recorded.
  // Consent is the store's: (provider id, origin of its base address), kept like folder trust. A test may inject a seam instead.
  const consentStore: ConsentStore = { has: (id, origin) => o.store.hasConsent(id, origin), grant: (id, origin) => o.store.grantConsent(id, origin), revoke: (id) => o.store.revokeConsent(id) };
  const sender = hostSend(mods, { env: o.env ?? process.env, home: o.dir }, consentStore.has);
  const asks = o.consent ?? consentFrom(mods, o.store);
  const live = createLiveModels({
    ...liveListSource(mods, { env: o.env ?? process.env, home: o.dir, send: o.send ?? sender.send!, ...(sender.redact ? { redact: sender.redact } : {}) }),
    consented: (provider) => asks(provider) === undefined,
    holdsSecret: (t) => !!sender.holdsSecret?.(t) || !!o.redactor?.has(t),
  });
  const list = (p: ProviderView) => listModels(p, catalogOf(p), readSetting(o.store, 'pickerLimit'), live.ids(p.id));
  const token = randomBytes(32).toString('hex');
  const sessions = new Map<string, Session>();
  const subs = new Set<(row: LogRow) => void>();
  // One copy of the rule: the header's switch and a run's model step both read the list and the estimate here.
  const describeModel: DescribeModel = (engine, model, used) => {
    const provider = providers.find((p) => p.id === engine);
    const found = provider && list(provider).find((m) => m.id === model);
    const price = provider && used !== undefined ? priceFor(provider, catalogOf(provider), model, used) : undefined;
    // A live id the picker's limit cut is still a listed model.
    return { listed: !!found || (!!provider && live.ids(provider.id).includes(model)), label: found?.label ?? model, estimate: switchEstimate(used, price), ...(price ? { source: price.source } : {}) };
  };
  const describeEffort: DescribeEffort = (engine, id) => {
    const found = providers.find((p) => p.id === engine)?.efforts.find((e) => e.id === id);
    return { listed: !!found, label: found?.label ?? id };
  };
  // The settings are read when a turn starts, so a change in Settings counts from the next reply.
  const settings = { get maxCallsPerTurn() { return readSetting(o.store, 'maxCallsPerTurn'); } };
  // What Settings > Providers acts on. `send` is the one function that attaches a key; Test connection uses nothing else.
  const modEnv = () => ({
    home: o.dir, catalogDir: o.catalogDir ?? CATALOG_DIR, mods, consent: consentStore, send: o.send ?? sender.send!, env: o.env ?? process.env, redact: sender.redact!,
    ...(o.testTimeoutMs !== undefined ? { testTimeoutMs: o.testTimeoutMs } : {}),
  });
  const deps: SessionDeps = { store: o.store, makeEngine: (a) => o.makeEngine({ ...a, settings }), dir: o.dir, env: childEnv(o.env ?? process.env, keyEnvNames(mods)), ...(o.redactor ? { redactor: o.redactor } : {}), describeModel, describeEffort, folderTrust: folderTrustFrom(mods), providers: checkEnvFrom(mods, { env: o.env ?? process.env, home: o.dir }), consent: asks, origin: (provider) => providerOrigin(mods, provider), onRow: (row) => { for (const f of subs) f(row); } };
  let engines: Array<{ id: string } & EngineProbe> = [];
  let host = '';
  let origin = '';

  // One probe per installed provider; a probe that throws is that provider's problem line, not the server's failure.
  // Everything a probe says (version, problems, ...) is provider text and may carry a key.
  const hide = <T>(v: T): T => (o.redactor ? o.redactor.redactJson(v) : v);
  const probeNow = (): Promise<Array<{ id: string } & EngineProbe>> => Promise.all(providers.map(async (p) => {
    try {
      return hide({ id: p.id, ...(await o.probe(p.id)) });
    } catch (e) {
      return hide({ id: p.id, installed: false, loggedIn: false, capabilities: { midTurnSteer: 'none' as const, preToolDeny: false, resume: false }, problems: [e instanceof Error ? e.message : String(e)] });
    }
  }));

  const defaultProvider = () => defaultProviderOf(providers, readSetting(o.store, 'defaultProvider'));

  const view = (s: Session) => {
    const r = s.info();
    return {
      id: r.id, cwd: r.cwd, engine: r.engine, model: r.model, effort: r.effort, title: r.title,
      autoApprove: r.autoApprove, createdAt: r.createdAt, updatedAt: r.updatedAt, status: s.status(),
    };
  };
  // The picker's view of one session (spec 9.1, 9.3, 9.4): its provider's status, `provider:model`, and where it may switch.
  const providerState = (s: Session): SessionProviderState => {
    const r = s.info();
    const own = providers.find((p) => p.id === r.engine);
    return {
      provider: s.providerStatus(),
      composite: `${r.engine}:${r.model ?? own?.defaultModel ?? ''}`,
      switchTo: providers.filter((p) => deps.providers!.installed(p.id)).map((p) => {
        const why = s.providerRefusal(p.id);
        return { provider: p.id, allowed: why === undefined, ...(why ? { why } : {}) };
      }),
    };
  };
  const statusOf = (id: string): ProviderGroup['status'] => {
    const key = deps.providers!.facts(id)?.key;
    return key === 'missing' ? 'needs-key' : key === 'none' ? 'keyless' : 'installed';
  };
  const groups = (): ProviderGroup[] => providers.filter((p) => deps.providers!.installed(p.id)).map((p) => {
    const consent = providerStatus(modEnv(), p.id)?.consent;
    return { id: p.id, label: p.label, status: statusOf(p.id), ...(consent ? { consent } : {}), models: list(p) };
  });

  function create(b: Body): Reply {
    if (!str(b.cwd) || !path.isAbsolute(b.cwd)) return fail(400, 'cwd must be an absolute path.');
    if (b.cwd.includes('\0') || !fs.statSync(b.cwd, { throwIfNoEntry: false })?.isDirectory()) return fail(400, 'cwd is not a folder.');
    if (b.engine !== undefined && !str(b.engine)) return fail(400, 'engine must be a string.');
    const provider = b.engine === undefined ? defaultProvider() : providers.find((p) => p.id === b.engine);
    if (!provider) return fail(400, b.engine === undefined ? 'No provider is installed.' : `No provider \`${b.engine}\` is installed.`);
    for (const k of ['model', 'effort', 'title'] as const) if (b[k] !== undefined && !str(b[k])) return fail(400, `${k} must be a string.`);
    const row = o.store.createSession({
      id: randomBytes(6).toString('hex'), cwd: b.cwd, engine: provider.id,
      model: str(b.model) ? b.model : provider.defaultModel,
      effort: str(b.effort) ? b.effort : provider.defaultEffort, ...(str(b.title) ? { title: b.title } : {}),
    });
    const s = openSession(deps, row, true);
    sessions.set(row.id, s);
    return ok(view(s));
  }

  function workflows(cwd: string | null): Reply {
    if (!cwd || !path.isAbsolute(cwd)) return fail(400, 'cwd must be an absolute path.');
    const list = (folder: string, scope: 'project' | 'user') =>
      !fs.existsSync(folder) ? [] : fs.readdirSync(folder).filter((f) => f.endsWith('.reins.md')).sort().map((f) => {
        const file = path.join(folder, f);
        return { path: file, name: f.slice(0, -'.reins.md'.length), scope, diagnostics: loadWorkflow(file).diagnostics };
      });
    return ok({ workflows: [...list(path.join(cwd, '.reins', 'workflows'), 'project'), ...list(path.join(o.dir, 'workflows'), 'user')] });
  }

  let picking: AbortController | undefined;
  async function pick(res: http.ServerResponse): Promise<Reply> {
    if (!o.pickFolder) return fail(501, 'This machine has no folder picker.');
    // A new click replaces a dialog that is stuck or lost behind a window, instead of locking the picker out.
    picking?.abort();
    const ac = (picking = new AbortController());
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      const p = await o.pickFolder(ac.signal);
      return p && path.isAbsolute(p) && fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ? ok({ path: p }) : ok({ cancelled: true });
    } catch (e) {
      return fail(501, e instanceof Error ? e.message : 'No folder picker is available.');
    } finally {
      if (picking === ac) picking = undefined;
    }
  }

  // Settings > Providers (spec 7.3 to 7.5). The loader has already swapped its registry inside `mods`; what the server copied from it is read again here.
  const afterModChange = () => {
    providers = providerViews(mods);
    deps.env = childEnv(o.env ?? process.env, keyEnvNames(mods));
    o.redactor?.refresh();
  };
  async function modsApi(req: http.IncomingMessage, sub: string | undefined, action: string | undefined): Promise<Reply> {
    const env = modEnv();
    const given = async <T>(use: (b: Record<string, unknown>) => Promise<T> | T): Promise<T | Reply> => {
      const r = await parse(req);
      return 'fail' in r ? r.fail : use(r.b as Record<string, unknown>);
    };
    let id: string | undefined;
    try { id = sub === undefined ? undefined : decodeURIComponent(sub); } catch { return fail(400, 'That is not a valid mod id.'); }
    // A key in the address would sit in logs and history; the route refuses before it reads the body, and never repeats the address.
    if (action === 'key' && (req.url ?? '').includes('?')) return fail(400, 'A key goes in the request body, never in the address.');
    if (req.method === 'GET' && id === undefined) return listMods(env);
    let reply: Reply | undefined;
    if (req.method === 'POST' && id === 'install' && !action) reply = (await given((b) => installMods(env, b.ids))) as Reply;
    else if (req.method === 'POST' && id === 'custom' && !action) reply = (await given((b) => addCustom(env, b))) as Reply;
    else if (req.method === 'PUT' && id !== undefined && !action) reply = (await given((b) => editMod(env, id, b))) as Reply;
    else if (req.method === 'DELETE' && id !== undefined && !action) reply = await removeMod(env, id);
    else if (req.method === 'POST' && id !== undefined && (action === 'enable' || action === 'disable')) reply = await setEnabled(env, id, action === 'enable');
    else if (req.method === 'POST' && id !== undefined && action === 'reinstall') reply = await reinstallMod(env, id);
    else if (req.method === 'PUT' && id !== undefined && action === 'key') reply = (await given((b) => putKey(env, id, b))) as Reply;
    else if (req.method === 'DELETE' && id !== undefined && action === 'key') reply = await deleteKey(env, id);
    else if (req.method === 'POST' && id !== undefined && action === 'consent') reply = (await given((b) => setConsent(env, id, b))) as Reply;
    else if (req.method === 'DELETE' && id !== undefined && action === 'consent') reply = await revokeConsent(env, id);
    else if (req.method === 'POST' && id !== undefined && action === 'test') reply = await testConnection(env, id);
    if (!reply) return fail(404, 'Not found.');
    if (reply.status === 200) afterModChange(); // a refused change touched nothing
    return reply;
  }

  async function dispatch(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<Reply> {
    const p = url.pathname;
    const modsRoute = /^\/api\/mods(?:\/([^/]+)(?:\/([a-z]+))?)?$/.exec(p);
    if (modsRoute) {
      const r = await modsApi(req, modsRoute[1], modsRoute[2]);
      return { status: r.status, body: hide(r.body) };
    }
    if (req.method === 'GET' && p === '/api/state') {
      void catalog?.refresh(); // never rejects; a no-op inside 4 hours
      // The live lists are asked for here (a keyed provider only with consent); the answer shows in the next state. Never rejects.
      for (const pr of providers) if (deps.providers!.installed(pr.id)) void live.refresh(pr.id);
      // Provider and model names come from manifests and the catalog: text a mod or a provider wrote.
      return ok(hide({ sessions: [...sessions.values()].map((s) => ({ ...view(s), ...providerState(s) })), engines: engines.filter((e) => providers.some((pr) => pr.id === e.id)), groups: groups(), providers: providers.map((pr) => ({ id: pr.id, label: pr.label, defaultModel: pr.defaultModel, defaultEffort: pr.defaultEffort, efforts: pr.efforts, models: list(pr) })) }));
    }
    if (req.method === 'POST' && p === '/api/state/probe') { engines = await probeNow(); return ok({ engines }); }
    if (req.method === 'GET' && p === '/api/tags') return ok({ tags: tagCatalogue() });
    if (req.method === 'GET' && p === '/api/workflows') return workflows(url.searchParams.get('cwd'));
    if (req.method === 'GET' && p === '/api/editor-state') {
      const key = editorKey(url.searchParams.get('cwd'));
      if (!key) return fail(400, 'cwd must be an absolute path.');
      const raw = o.store.getEditorState(key);
      let state: unknown = null;
      try { if (raw !== undefined) state = JSON.parse(raw); } catch { /* a corrupt row reads as no state */ }
      return ok({ state: isObject(state) ? state : null });
    }
    if (req.method === 'PUT' && p === '/api/editor-state') {
      const r = await parse(req);
      if ('fail' in r) return r.fail;
      const key = editorKey(r.b.cwd);
      if (!key) return fail(400, 'cwd must be an absolute path.');
      if (!isObject(r.b.state)) return fail(400, 'state must be a JSON object.');
      const json = JSON.stringify(r.b.state);
      if (Buffer.byteLength(json) > MAX_EDITOR_STATE) return fail(413, 'The editor state is larger than 64 KB.');
      o.store.putEditorState(key, json);
      return ok();
    }
    if (req.method === 'POST' && p === '/api/pick-folder') return pick(res);
    if (req.method === 'POST' && p === '/api/sessions') {
      const r = await parse(req);
      return 'fail' in r ? r.fail : create(r.b);
    }
    const m = /^\/api\/sessions\/([^/]+)\/([a-z]+)$/.exec(p);
    if (m) {
      const s = sessions.get(m[1]!);
      if (!s) return fail(404, 'No such session.');
      if (req.method === 'GET' && m[2] === 'log') {
        const after = url.searchParams.get('after') ?? '0';
        if (!/^\d+$/.test(after)) return fail(400, 'after must be a sequence number.');
        return ok({ rows: o.store.readLog(s.id,Number(after)) });
      }
      const cwd = s.info().cwd;
      if (req.method === 'GET' && m[2] === 'workflow') {
        const p = url.searchParams.get('path');
        return p ? readWorkflow(cwd, o.dir, p) : fail(400, 'path must be a non-empty string.');
      }
      if (req.method === 'PUT' && m[2] === 'workflow') {
        const r = await parse(req);
        if ('fail' in r) return r.fail;
        const { path: p, text, create } = r.b;
        if (!str(p) || !p || !str(text)) return fail(400, 'path and text must be strings.');
        if (create !== undefined && typeof create !== 'boolean') return fail(400, 'create must be a boolean.');
        return writeWorkflow(cwd, o.dir, p, text, create === true, o.redactor?.has);
      }
      if (req.method === 'POST' && m[2] === 'preview') {
        const r = await parse(req);
        if ('fail' in r) return r.fail;
        const { path: p, text, stepId, workflow } = r.b;
        if (stepId !== undefined && !str(stepId)) return fail(400, 'stepId must be a string.');
        if (workflow === undefined) {
          if (!str(p) || !p || !str(text)) return fail(400, 'path and text must be strings.');
          return previewWorkflow(cwd, o.dir, p, text, stepId);
        }
        if (!str(p) || !p || text !== undefined) return fail(400, 'Send a path and either text or workflow.');
        if (!isObject(workflow) || !Array.isArray(workflow.steps) || !Array.isArray(workflow.autos) || !Array.isArray(workflow.always) || !isObject(workflow.budget)) return fail(400, 'The workflow model is malformed.');
        let printed: string;
        try { printed = printWorkflow(workflow as unknown as Workflow); } catch { return fail(400, 'The workflow model is malformed.'); }
        const out = previewWorkflow(cwd, o.dir, p, printed, stepId);
        return out.status === 200 ? { ...out, body: { ...(out.body as object), text: printed } } : out;
      }
      if (req.method === 'POST' && Object.hasOwn(actions, m[2]!)) {
        const r = await parse(req);
        return 'fail' in r ? r.fail : actions[m[2]!]!(s, r.b, { store: o.store, describe: describeModel, describeEffort, installed: deps.providers!.installed });
      }
    }
    return fail(404, 'Not found.');
  }

  function stream(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const after = new Map<string, number>();
    for (const part of (url.searchParams.get('after') ?? '').split(',')) {
      const i = part.lastIndexOf(':');
      const n = Number(part.slice(i + 1));
      if (i > 0 && Number.isInteger(n) && n >= 0) after.set(part.slice(0, i), n);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.flushHeaders();
    const write = (row: LogRow) => { res.write(`data: ${JSON.stringify(row)}\n\n`); };
    // Replay and subscribe in one tick, so no row can fall between the two.
    for (const id of sessions.keys()) for (const row of o.store.readLog(id, after.get(id) ?? 0)) write(row);
    res.write('event: replay_done\ndata: {}\n\n');
    subs.add(write);
    const beat = setInterval(() => res.write(': heartbeat\n\n'), o.heartbeatMs ?? 15_000);
    req.on('close', () => { clearInterval(beat); subs.delete(write); });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    try {
      if (req.headers.host !== host) return send(res, fail(403, 'Bad Host header.'));
      if (req.headers.origin !== undefined && req.headers.origin !== origin) return send(res, fail(403, 'Bad Origin header.'));
      let url: URL;
      try {
        url = new URL(req.url ?? '/', origin);
      } catch {
        return send(res, fail(400, 'Bad URL.'));
      }
      if (!url.pathname.startsWith('/api/')) {
        return o.appDir && req.method === 'GET' ? serveStatic(o.appDir, url.pathname, res) : send(res, fail(404, 'Not found.'));
      }
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const given = bearer ?? (url.pathname === '/api/stream' ? url.searchParams.get('token') : null);
      if (given === null || given === undefined || !sameToken(given, token)) return send(res, fail(401, 'A valid token is required.'));
      if (req.method === 'GET' && url.pathname === '/api/stream') return stream(req, res, url);
      send(res, await dispatch(req, res, url));
    } catch {
      // A fixed message: the text of an error can carry paths. ponytail: nothing is logged; add a logger when there is one.
      if (res.headersSent) res.end();
      else send(res, fail(500, 'Internal error.'));
    }
  }

  // Before listen: with a fixed --port the second instance would die on EADDRINUSE instead of naming the first.
  const already = o.lockFile ? runningLock(o.lockFile) : undefined;
  if (already) throw Object.assign(new Error(`Reins is already serving on port ${already.port}.`), { running: already });

  const server = http.createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  host = `127.0.0.1:${port}`;
  origin = `http://${host}`;

  let locked = false;
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= (async () => {
    subs.clear();
    catalog?.close();
    const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await stopped;
    await Promise.all([...sessions.values()].map((s) => s.shutdown()));
    ownMods?.dispose();
    if (locked && o.lockFile) releaseLock(o.lockFile, process.pid);
  })());

  if (o.lockFile) {
    const got = takeLock(o.lockFile, { pid: process.pid, port, token });
    if (!got.ok) {
      await close();
      throw Object.assign(new Error(`Reins is already serving on port ${got.running.port}.`), { running: got.running });
    }
    locked = true;
  }
  try {
    recover(o.store);
    for (const row of o.store.listSessions()) sessions.set(row.id, openSession(deps, row));
    engines = await probeNow();
  } catch (e) {
    await close();
    throw e;
  }
  void catalog?.refresh(); // once at start; the disk copy is served meanwhile
  return { port, token, url: `${origin}/#token=${token}`, close };
}
