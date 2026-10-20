import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TagEntry } from '@reins/server/tags.js';
import { post } from './api.js';
import { Composer } from './Composer.js';
import type { EditorState, Tab } from './editorState.js';
import { Feed } from './FeedView.js';
import { feed } from './feed.js';
import type { Actions } from './rows.js';
import { RunDock, type Surface } from './RunDock.js';
import { PHASE, runView, thinkingHeads, thinkingNow } from './runState.js';
import { TextTab } from './TextTab.js';
import { mergeOutput, openQuestions, title, type Sess } from './state.js';
import { OptionPicker } from './OptionPicker.js';
import type { Engines } from './ProviderBanner.js';
import { compressBlock, compressBusy, contextWords, effortBlock, hasReplied, modelGroups, pickerBlock, shownEffort, shownModel, usableProvider, usageOf, windowOf } from './usage.js';

export type Provider = { id: string; label: string; defaultModel: string; defaultEffort: string; efforts: Array<{ id: string; label: string }>; models: Array<{ id: string; label: string; window?: number }> };

export function Chat({ sess, catalogue, providers, engines = [], takeRefill, tab, onTab, restore, onState, onDirty, onError }: {
  sess: Sess; catalogue: TagEntry[]; providers: Provider[]; engines?: Engines; takeRefill: (input: string) => string; tab: Tab; onTab: (t: Tab) => void;
  restore?: EditorState; onState: (patch: Partial<EditorState>) => void;
  onDirty: (dirty: boolean) => void; onError: (message: string) => void;
}) {
  const base = `/api/sessions/${sess.id}`;
  const log = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const [fresh, setFresh] = useState(false);
  const [dockOpen, setDockOpen] = useState<Record<Surface, boolean>>({ chat: false, blocks: false }); // the panel's body is open or closed per surface
  // ponytail: Dismiss is in memory; a reload shows the last run's marks again.
  const [dismissed, setDismissed] = useState<string>();
  const [open, setOpen] = useState<Record<string, boolean>>({}); // the user's open / closed choice per knot, in memory
  const [reveal, setReveal] = useState<{ runId: string; id: string; n: number }>();
  const [focus, setFocus] = useState<{ key: string; n: number }>();
  const rows = useMemo(() => mergeOutput(sess.rows), [sess.rows]);
  const busy = sess.status === 'running' || sess.status === 'waiting';
  const usage = useMemo(() => usageOf(sess.rows), [sess.rows, sess.lastSeq]);
  const models = providers.find((p) => p.id === sess.engine)?.models ?? [];
  const shown = shownModel(sess, usage, providers) ?? '';
  const sessionModel = { id: shown, label: `${models.find((m) => m.id === shown)?.label ?? shown} (session)` };
  const efforts = providers.find((p) => p.id === sess.engine)?.efforts ?? [];
  const level = shownEffort(sess, providers) ?? '';
  const sessionEffort = { id: level, label: `${efforts.find((e) => e.id === level)?.label ?? level} (session)` };
  // The stream's window wins; the catalog's (from /api/state) only fills a gap.
  const ctx = contextWords(usage, windowOf(providers, sess.engine, shown));
  const asking = openQuestions(sess).some((r) => (r.data as { kind?: string }).kind === 'switch');
  // every working provider's models, the session's first: `provider:model` here; the Blocks tab keeps the session's own models as plain ids
  const usable = (id: string) => usableProvider(id, sess.installed, engines);
  const modelList = modelGroups(providers, sess.engine, usable);
  const stepModels = modelGroups(providers, sess.engine, usable, true);
  const block = sess.missing ?? pickerBlock({ busy, detached: sess.detached.length, asking });
  const effortOff = effortBlock(busy);
  // the server accepts Compress while only a switch card waits (it closes the card)
  const cb = compressBlock({
    busy: compressBusy(sess.status, openQuestions(sess).map((r) => (r.data as { kind?: string }).kind)),
    replied: hasReplied(sess.rows),
  });
  const run = useMemo(() => runView(sess), [sess]);
  // the panel shows for a run that is live or just ended, not for a plain turn (busy) or a run the user dismissed
  const chatPanel = run.phase !== 'none' && run.phase !== 'busy' && !(run.runId === dismissed && PHASE[run.phase].ended);
  const f = useMemo(() => feed(rows, run, new Set(sess.open)), [rows, run, sess.open]);
  // only the head of a thinking burst draws; it says "thinking…" while it is the newest engine row of a busy session
  const thinking = useMemo(() => { const now = thinkingNow(sess.rows); return { heads: thinkingHeads(sess.rows), ...(busy && now ? { now: now.seq } : {}) }; }, [sess]);

  const act: Actions = {
    answer: async (questionId, answer) => { await post(`${base}/answer`, { questionId, answer }); },
    resume: (runId) => { post(`${base}/resume`, { runId }).catch((e) => onError(e.message)); },
  };

  // Blocks ↗ on a knot: the Blocks tab shows that step of that run (TextTab checks the run is still the newest and the file still matches)
  const toBlock = (runId: string, step: string) => {
    setReveal((p) => ({ runId, id: step, n: (p?.n ?? 0) + 1 }));
    onTab('blocks');
  };
  // Show in Chat: the newest run's last knot of that step opens and takes the focus
  const onChat = (step?: string) => {
    if (step === undefined) { setStick(true); setFresh(false); }
    const strand = f.pieces.find((p) => p.type === 'run' && p.newest);
    const k = step === undefined || strand?.type !== 'run' ? undefined : strand.items.flatMap((i) => ('knot' in i ? [i.knot] : [])).filter((x) => x.step === step).at(-1);
    if (k) {
      setOpen((o) => ({ ...o, [k.key]: true }));
      setFocus((p) => ({ key: k.key, n: (p?.n ?? 0) + 1 }));
    }
    onTab('chat');
  };

  // Show in Chat: the knot's toggle comes into view and takes the focus, once. Here, not in Feed: the Composer (a later child) focuses itself on mount and would win.
  useEffect(() => {
    if (!focus || tab !== 'chat') return;
    const el = log.current?.querySelector<HTMLElement>(`[data-knot="${CSS.escape(focus.key)}"] .sx-kbtn`);
    el?.scrollIntoView({ block: 'start' });
    el?.focus({ preventScroll: true });
    setFocus(undefined);
  }, [focus?.n, tab]);

  useLayoutEffect(() => {
    const el = log.current;
    if (!el) return;
    if (stick) el.scrollTop = el.scrollHeight;
    else setFresh(true);
  }, [sess.rows.length, tab]);

  useLayoutEffect(() => {
    const el = log.current;
    const content = el?.querySelector('.sx-rein');
    if (!stick || !el || !content) return;
    const observer = new ResizeObserver(() => { el.scrollTop = el.scrollHeight; });
    observer.observe(content);
    observer.observe(el);
    return () => observer.disconnect();
  }, [stick, tab]);

  return (
    <main className="chat">
      <header className="chead">
        <div>
          <h2>{title(sess)}</h2>
          <div className="faint" title={sess.cwd}>{sess.cwd}</div>
        </div>
        <span className={`status ${sess.status}`}><span className={`dot ${sess.status}`} /> {sess.status}</span>
        <label className="sx-model">
          Model
          <OptionPicker label="Model" options={modelList} value={sess.engine ? `${sess.engine}:${shown}` : shown} disabled={block !== undefined} other={{ ...(sess.engine ? { own: sess.engine } : {}) }}
            title={block ?? (usage ? `In use: ${usage.model}` : undefined)}
            onChange={(v) => post(`${base}/settings`, { model: v }).catch((err) => onError(err.message))} />
        </label>
        <label className="sx-model">
          Reasoning
          <OptionPicker label="Reasoning" options={efforts} value={level} disabled={effortOff !== undefined || sess.missing !== undefined} title={sess.missing ?? effortOff}
            onChange={(v) => post(`${base}/settings`, { effort: v }).catch((err) => onError(err.message))} />
        </label>
        <span className="sx-ctx" title={ctx.title}>{ctx.text}</span>
        <button className="sx-compress" disabled={cb !== undefined} title={cb ?? 'Summarise the conversation so far to free context. It costs one model call.'}
          onClick={() => post(`${base}/compress`).catch((e) => onError(e.message))}>Compress</button>
        <span className="faint" aria-label="Session cost">${sess.cost.toFixed(4)}</span>
        <label className="switch">
          <input type="checkbox" checked={sess.autoApprove} onChange={(e) => post(`${base}/settings`, { autoApprove: e.target.checked }).catch((e) => onError(e.message))} />
          Auto-approve
        </label>
        <button disabled={sess.status === 'closed'} onClick={() => { if (window.confirm('Close this session?')) post(`${base}/close`).catch((e) => onError(e.message)); }}>Close</button>
      </header>
      <div className="tabs" role="tablist">
        {(['chat', 'blocks', 'text'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => onTab(t)}>{{ chat: 'Chat', blocks: 'Blocks', text: 'Text' }[t]}</button>
        ))}
      </div>
      {tab === 'chat' ? (
        <>
          <Feed f={f} sess={sess} run={run} act={act} thinking={thinking} open={open} logRef={log}
            onToggle={(key, next) => setOpen((o) => ({ ...o, [key]: next }))} onBlock={toBlock}
            onScroll={(e) => {
              const el = e.currentTarget;
              const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              setStick(bottom);
              if (bottom) setFresh(false);
            }} />
          {fresh && <button className="pill" onClick={() => { setStick(true); setFresh(false); log.current!.scrollTop = log.current!.scrollHeight; }}>Jump to live ↓</button>}
          {sess.missing && <div className="banner bad" role="alert">{sess.missing}</div>}
          <Composer key={sess.id} id={sess.id} cwd={sess.cwd} busy={busy} locked={sess.missing !== undefined} catalogue={catalogue} takeRefill={takeRefill}
            bar={chatPanel && <RunDock run={run} sess={sess} act={act} surface="chat" match following={false}
              open={dockOpen.chat} onOpen={(o) => setDockOpen((d) => ({ ...d, chat: o }))} onJump={() => onTab('blocks')} onDismiss={() => setDismissed(run.runId)} />} />
        </>
      ) : (
        restore === undefined ? <p className="hint">Loading…</p>
          : <TextTab view={tab} onView={onTab} sess={sess} models={stepModels} efforts={efforts} sessionModel={sessionModel} sessionEffort={sessionEffort} run={run} act={act} restore={restore} onState={onState} onDirty={onDirty} onRun={() => onTab('chat')}
            reveal={reveal} onRevealed={() => setReveal(undefined)} onChat={onChat} dockOpen={dockOpen.blocks} onDockOpen={(o) => setDockOpen((d) => ({ ...d, blocks: o }))} dismissed={dismissed} onDismiss={setDismissed} />
      )}
    </main>
  );
}
