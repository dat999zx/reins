import { useEffect, useRef, useState } from 'react';
import type { EngineProbe } from '@reins/core';
import type { LogRow } from '@reins/server/store.js';
import type { TagEntry } from '@reins/server/tags.js';
import { ApiError, get, initToken, post, stream } from './api.js';
import { Chat } from './Chat.js';
import { Rail } from './Rail.js';
import { afterOf, initial, loadSessions, reduceAll, takeRefill, type SessionView, type State } from './state.js';

const loadedAt = Date.now();
type Engines = Array<{ id: string } & EngineProbe>;

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
  const [catalogue, setCatalogue] = useState<TagEntry[]>([]);
  const [ready, setReady] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [selected, setSelected] = useState<string | null>(fromHash);
  const [tab, setTab] = useState<'chat' | 'text'>('chat');
  const [notice, setNotice] = useState('');
  const [pathBox, setPathBox] = useState(false);
  const [path, setPath] = useState('');
  const dirty = useRef(false);

  const commit = (next: State) => { stRef.current = next; setSt(next); };

  useEffect(() => {
    if (!token) return;
    let es: EventSource | undefined;
    let stopped = false;
    const buffer: LogRow[] = [];
    let raf = 0;
    const flush = () => {
      raf = 0;
      const rows = buffer.splice(0);
      if (rows.length) commit(reduceAll(stRef.current, rows, loadedAt));
    };

    async function connect() {
      try {
        const r = await get<{ sessions: SessionView[]; engines: Engines }>('/api/state');
        if (stopped) return;
        commit(loadSessions(stRef.current, r.sessions));
        setEngines(r.engines);
        setReady(true);
      } catch (e) {
        if (stopped) return;
        if (e instanceof ApiError && e.status === 401) return setToken(null);
        setReconnecting(true);
        setTimeout(() => void connect(), 1000);
        return;
      }
      flush();
      es = stream(afterOf(stRef.current));
      es.onopen = () => setReconnecting(false);
      es.onmessage = (m) => {
        buffer.push(JSON.parse(m.data));
        raf ||= requestAnimationFrame(flush);
      };
      es.onerror = () => {
        es?.close();
        setReconnecting(true);
        setTimeout(() => void connect(), 1000);
      };
    }
    void connect();
    get<{ tags: TagEntry[] }>('/api/tags').then((r) => setCatalogue(r.tags)).catch(() => {});
    return () => { stopped = true; es?.close(); cancelAnimationFrame(raf); };
  }, [token]);

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 4000); };
  const leave = () => !dirty.current || window.confirm('Discard unsaved changes?');
  const select = (id: string) => {
    if (id !== selected && !leave()) return;
    setSelected(id);
    setTab('chat');
    toHash(id);
  };

  const start = async (cwd: string) => {
    try {
      const v = await post<SessionView>('/api/sessions', { cwd, engine: 'claude' });
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
  if (!ready) return <div className="center"><p>{reconnecting ? 'Reconnecting…' : 'Loading…'}</p></div>;

  const problem = engines[0] && (!engines[0].installed || !engines[0].loggedIn) ? engines[0] : undefined;
  const sess = selected ? st.sessions[selected] : undefined;

  return (
    <div className="app">
      {reconnecting && <div className="banner warn" role="status">Reconnecting to the server…</div>}
      {problem && <div className="banner bad" role="alert">{problem.problems.join(' ') || 'The engine is not ready.'}</div>}
      {notice && <div className="banner bad" role="alert">{notice}</div>}
      <div className="cols">
        <Rail
          state={st} selected={selected} onSelect={select} onNew={() => void newSession()} onPlus={(cwd) => void start(cwd)}
          onRename={(id, title) => { post(`/api/sessions/${id}/settings`, { title }).catch((e) => flash(e.message)); }}
          pathBox={pathBox && (
            <form className="pathbox" onSubmit={(e) => { e.preventDefault(); void start(path.trim()).then(() => setPath('')); }}>
              <label>No folder picker here. Absolute folder path
                <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/me/project" />
              </label>
              <button type="submit" disabled={!path.trim()}>Start</button>
            </form>
          )}
        />
        {sess ? (
          <Chat
            key={sess.id} sess={sess} catalogue={catalogue} tab={tab}
            onTab={(t) => { if (t === tab || t === 'text' || leave()) setTab(t); }}
            onDirty={(d) => { dirty.current = d; }} onError={flash}
            takeRefill={(input) => {
              const r = takeRefill(stRef.current, sess.id, input);
              if (r.state !== stRef.current) queueMicrotask(() => commit(r.state));
              return r.text;
            }}
          />
        ) : (
          <main className="chat empty"><p className="hint">{Object.keys(st.sessions).length ? 'Select a session.' : 'No sessions yet — New session, or Ctrl+O'}</p></main>
        )}
      </div>
    </div>
  );
}
