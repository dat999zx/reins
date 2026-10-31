import { useEffect, useRef, useState } from 'react';
import type { LogRow } from '@reins/server/store.js';
import type { TagEntry } from '@reins/server/tags.js';
import { ApiError, cleanRun, get, initToken, mergeRun, parallelRuns, post, resumeAll, setCap, stopAll, stream } from './api.js';
import { busyPhase, type ParallelView } from './parallel.js';
import { ParallelStart } from './ParallelStart.js';
import { setCards, setKinds } from './canvasKinds.js';
import { setConds } from './condKinds.js';
import { setQuestions } from './questions.js';
import { Chat, type Provider } from './Chat.js';
import { FirstRun } from './FirstRun.js';
import { cardsOf, type ChooserEntry, type PackRow } from './firstRunCards.js';
import { loadEditorState, makeSaver, type EditorState, type Tab } from './editorState.js';
import { ProviderBanner, type Engines } from './ProviderBanner.js';
import { Providers } from './Providers.js';
import { Rail } from './Rail.js';
import { afterOf, dropSessions, finishReplay, initial, loadSessions, pageTitle, reduceAll, takeRefill, type SessionView, type State } from './state.js';

const loadedAt = Date.now();

const fromHash = () => new URLSearchParams(location.hash.slice(1)).get('s');
const toHash = (id: string) => {
  const h = new URLSearchParams(location.hash.slice(1));
  h.set('s', id);
  history.replaceState(null, '', `${location.pathname}${location.search}#${h}`);
};

export function App() {
  const [token, setToken] = useState(() => initToken());
  const [st, setSt] = useState<State>(initial);
  const stRef = useRef<State>(st);
  const [engines, setEngines] = useState<Engines>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [catalogue, setCatalogue] = useState<TagEntry[]>([]);
  const [ready, setReady] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [selected, setSelected] = useState<string | null>(fromHash);
  const [tab, setTab] = useState<Tab>('chat');
  const [notice, setNotice] = useState('');
  const [settings, setSettings] = useState(false);
  const [pathBox, setPathBox] = useState(false);
  const [path, setPath] = useState('');
  const dirty = useRef(false);
  // The first-run screen (spec 7.3): the chooser entries while it is showing. Asked once; a failed or empty answer never holds the app back.
  const [firstRun, setFirstRun] = useState<ChooserEntry[] | undefined>();
  const [pack, setPack] = useState<PackRow[]>([]);
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!token) return;
    get<{ firstRun: boolean; chooser: ChooserEntry[]; pack?: PackRow[]; mods: Array<{ id: string; kind: string; bundled: boolean }> }>('/api/mods')
      .then((r) => {
        const cards = cardsOf(r.chooser, r.mods.filter((m) => m.kind === 'provider' && m.bundled).map((m) => m.id));
        if (r.firstRun && cards.length) { setPack(r.pack ?? []); setFirstRun(cards); }
      })
      .catch(() => {})
      .finally(() => setAsked(true));
  }, [token]);

  // The faces of the blocks (core's and the mods'), asked once. The workspace waits for the answer, so a saved block of a mod's kind is not read as unknown.
  // Asked again on leaving Settings (a block may have been imported, trusted, disabled or removed there); the bump draws the new lists.
  const [kindsReady, setKindsReady] = useState(false);
  const [, drawKinds] = useState(0);
  const readKinds = () => get<{ kinds: unknown; conds: unknown; cards: unknown; questions: unknown }>('/api/kinds')
    .then((r) => { setKinds(r.kinds); setConds(r.conds); setCards(r.cards); setQuestions(r.questions); drawKinds((n) => n + 1); })
    .catch(() => {});
  useEffect(() => {
    if (!token) return;
    void readKinds().finally(() => setKindsReady(true));
  }, [token]);

  const commit = (next: State) => { stRef.current = next; setSt(next); };

  useEffect(() => {
    if (!token) return;
    let es: EventSource | undefined;
    let stopped = false;
    const buffer: LogRow[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const rows = buffer.splice(0);
      if (rows.length) commit(reduceAll(stRef.current, rows, loadedAt));
    };

    async function connect() {
      try {
        const r = await get<{ sessions: SessionView[]; engines: Engines; providers?: Provider[] }>('/api/state');
        if (stopped) return;
        commit(dropSessions(loadSessions(stRef.current, r.sessions), Object.keys(stRef.current.sessions).filter((id) => !r.sessions.some((v) => v.id === id))));
        setEngines(r.engines);
        setProviders(r.providers ?? []);
        setReady(true);
      } catch (e) {
        if (stopped) return;
        if (e instanceof ApiError && e.status === 401) return setToken(null);
        setReconnecting(true);
        setTimeout(() => void connect(), 1000);
        return;
      }
      void refreshParallel();
      flush();
      es = stream(afterOf(stRef.current));
      es.onopen = () => setReconnecting(false);
      es.addEventListener('replay_done', () => {
        clearTimeout(timer);
        flush();
        commit(finishReplay(stRef.current));
      });
      es.onmessage = (m) => {
        buffer.push(JSON.parse(m.data));
        // A timer, not requestAnimationFrame: rAF never fires in a background tab, so a waiting badge would never show.
        timer ??= setTimeout(flush, 16);
      };
      es.onerror = () => {
        es?.close();
        setReconnecting(true);
        setTimeout(() => void connect(), 1000);
      };
    }
    void connect();
    get<{ tags: TagEntry[] }>('/api/tags').then((r) => setCatalogue(r.tags)).catch(() => {});
    return () => { stopped = true; es?.close(); clearTimeout(timer); };
  }, [token]);

  // Leaving Settings: a provider may have been installed, disabled or removed, so the lists, the probes and each session's provider status are read again.
  useEffect(() => {
    if (settings || !ready) return;
    void readKinds();
    get<{ sessions: SessionView[]; engines: Engines; providers?: Provider[] }>('/api/state').then((r) => {
      commit(loadSessions(stRef.current, r.sessions));
      setEngines(r.engines);
      setProviders(r.providers ?? []);
    }).catch(() => {});
  }, [settings]);

  // Editor state per cwd. The saver stays silent until the stored state has loaded, so an early change can't overwrite it.
  const [editor, setEditor] = useState<Record<string, EditorState>>({});
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const saver = useRef<{ cwd: string; s: ReturnType<typeof makeSaver> } | undefined>(undefined);
  useEffect(() => {
    const flush = () => saver.current?.s.flush();
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);
  const view = useRef({ selected, tab });
  view.current = { selected, tab };
  const cwd = selected ? st.sessions[selected]?.cwd : undefined;

  useEffect(() => {
    if (!cwd || !kindsReady) return;
    saver.current?.s.flush();
    const s = makeSaver(cwd, undefined, undefined, (e) => flash(`Could not save the workspace layout: ${e.message}`));
    saver.current = { cwd, s };
    const known = editorRef.current[cwd];
    if (known) return s.ready(known);
    const at = view.current;
    let off = false;
    void loadEditorState(cwd, (n) => flash(`${n} loose block${n === 1 ? '' : 's'} could not be read and ${n === 1 ? 'was' : 'were'} dropped.`)).then((state) => {
      if (off) return;
      const same = view.current.selected === at.selected && view.current.tab === at.tab;
      const merged = same ? state : { ...state, tab: view.current.tab };
      if (same && state.tab) setTab(state.tab);
      editorRef.current = { ...editorRef.current, [cwd]: merged };
      setEditor(editorRef.current);
      s.ready(merged);
    });
    return () => { off = true; };
  }, [cwd, kindsReady]);

  const onState = (c: string, patch: Partial<EditorState>) => {
    const cur = editorRef.current[c];
    if (!cur) return;
    editorRef.current = { ...editorRef.current, [c]: { ...cur, ...patch } };
    setEditor(editorRef.current);
    if (saver.current?.cwd === c) saver.current.s.set(patch);
  };

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 4000); };
  // The parallel runs (spec 5B): read at connect, after each group action, and when the number of sessions changes. A failed read only flashes.
  const [parallel, setParallel] = useState<ParallelView[]>([]);
  const refreshParallel = () => parallelRuns().then(setParallel).catch((e) => flash(`Could not read the parallel runs: ${(e as Error).message}`));
  const sessionCount = Object.keys(st.sessions).length;
  useEffect(() => { if (ready) void refreshParallel(); }, [sessionCount]);
  const busy = parallel.some(busyPhase);
  useEffect(() => { if (!busy) return; const t = setInterval(() => void refreshParallel(), 3000); return () => clearInterval(t); }, [busy]);
  const groupAction = (act: () => Promise<unknown>) => act().catch((e) => flash((e as Error).message)).then(() => refreshParallel());
  const resumeAllFlash = (id: string) => groupAction(async () => {
    const r = await resumeAll(id);
    const list = Array.isArray(r.results) ? (r.results as Array<{ name?: string; result?: string; words?: string }>) : [];
    if (list.length) flash(list.map((t) => `${t.name ?? '?'}: ${t.result ?? '?'}${t.words ? ` (${t.words})` : ''}`).join('; '));
  });
  const leave = () => !dirty.current || window.confirm('Discard unsaved changes?');
  const select = (id: string) => {
    if (id !== selected && !leave()) return;
    setSettings(false);
    setSelected(id);
    setTab('chat');
    toHash(id);
  };

  const start = async (cwd: string) => {
    try {
      const v = await post<SessionView>('/api/sessions', { cwd });
      commit(loadSessions(stRef.current, [v]));
      select(v.id);
    } catch (e) {
      flash((e as Error).message);
    }
  };
  const newSession = async () => {
    try {
      const r = await post<{ path?: string; cancelled?: boolean }>('/api/pick-folder');
      if (r.path) await start(r.path);
    } catch (e) {
      if (e instanceof ApiError && e.status === 501) setPathBox(true);
      else flash((e as Error).message);
    }
  };
  // above the early returns: a token-less or loading page keeps the title of the last state, never a hook-order change
  const title = pageTitle(st);
  useEffect(() => { document.title = title; }, [title]);
  const newRef = useRef(newSession);
  newRef.current = newSession;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void newRef.current();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  if (!token) return <div className="center"><h1>Reins</h1><p>Open the address <code>reins</code> printed.</p></div>;
  if (!ready || !asked) return <div className="center"><p>{reconnecting ? 'Reconnecting…' : 'Loading…'}</p></div>;
  if (firstRun) return <div className="app"><FirstRun cards={firstRun} pack={pack} onLeave={() => setFirstRun(undefined)} /></div>;

  const sess = selected ? st.sessions[selected] : undefined;

  return (
    <div className="app">
      {reconnecting && <div className="banner warn" role="status">Reconnecting to the server…</div>}
      <ProviderBanner engines={engines} engine={sess?.engine} />
      {notice && <div className="banner bad" role="alert">{notice}</div>}
      <div className="cols">
        <Rail
          state={st} selected={selected} onSelect={select} onNew={() => void newSession()} onPlus={(cwd) => void start(cwd)}
          onRename={(id, title) => { post(`/api/sessions/${id}/settings`, { title }).catch((e) => flash(e.message)); }}
          onSettings={() => { if (leave()) setSettings(true); }}
          parallel={parallel} onStopAll={(id) => void groupAction(() => stopAll(id))} onResumeAll={(id) => void resumeAllFlash(id)}
          onCap={(id, usd) => void groupAction(() => setCap(id, usd))}
          onMerge={(id) => void groupAction(() => mergeRun(id))}
          onClean={(id) => void groupAction(async () => {
            const r = await cleanRun(id);
            // A removed task's session is gone from the server too (loadSessions only adds).
            if (r.forgotten) commit(dropSessions(stRef.current, (parallel.find((p) => p.id === id)?.tasks ?? []).filter((t) => r.removed.includes(t.name)).map((t) => t.sessionId)));
            if (r.kept.length) flash(`Kept: ${r.kept.map((k) => `${k.name} (${k.why})`).join(', ')}.`);
          })}
          parallelStart={<ParallelStart cwd={cwd} onStarted={() => void refreshParallel()} onError={flash} />}
          pathBox={pathBox && (
            <form className="pathbox" onSubmit={(e) => { e.preventDefault(); void start(path.trim()).then(() => setPath('')); }}>
              <label>No folder picker here. Absolute folder path
                <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/me/project" />
              </label>
              <button type="submit" disabled={!path.trim()}>Start</button>
            </form>
          )}
        />
        {settings ? <Providers onClose={() => setSettings(false)} /> : sess ? (
          <Chat
            key={sess.id} sess={sess} catalogue={catalogue} providers={providers} engines={engines} tab={tab}
            onTab={(t) => { if (t === tab || t !== 'chat' || leave()) { setTab(t); if (t !== tab) onState(sess.cwd, { tab: t }); } }}
            restore={editor[sess.cwd]} onState={(p) => onState(sess.cwd, p)}
            onDirty={(d) => { dirty.current = d; }} onError={flash}
            takeRefill={(input) => {
              const r = takeRefill(stRef.current, sess.id, input);
              if (r.state !== stRef.current) queueMicrotask(() => commit(r.state));
              return r.text;
            }}
          />
        ) : (
          <main className="chat empty"><p className="hint">{Object.keys(st.sessions).length ? 'Select a session.' : 'No sessions yet. New session, or Ctrl+O'}</p></main>
        )}
      </div>
    </div>
  );
}
