import { useState } from 'react';
import { showText } from '../../core/src/display.js';
import { previewRun, startRun } from './api.js';
import type { RunSpec } from './parallel.js';

const usd = (n: number) => `$${n}`;

export function PreviewLines({ repo, spec }: { repo: string; spec: RunSpec }) {
  const t = (s: string) => showText(s);
  const lines = [
    spec.title,
    `Repo: ${repo}`,
    ...spec.tasks.map((k) => `Task ${k.name}: ${k.playbook}, model ${k.model ?? 'default'}, effort ${k.effort ?? 'default'}`),
    `Install: ${spec.install !== undefined ? spec.install : 'none'}`,
    `Gate: ${spec.gate !== undefined ? spec.gate : 'none'}`,
    `Gate retry: ${spec.gateRetry !== undefined ? spec.gateRetry : 'same command'}`,
    `Reports: ${spec.reports ?? 'none'}`,
    `Copy: ${spec.copy.length ? spec.copy.join(', ') : 'none'}`,
    spec.capUsd !== undefined ? `Cap: ${usd(spec.capUsd)}` : 'no cap',
    spec.approve === 'fence' ? 'auto-approve: fence' : 'every request is a card',
    'Start runs these commands through the shell on this machine.',
  ];
  return <div className="preview">{lines.map((l, i) => <p key={i}>{t(l)}</p>)}</div>;
}

export function ParallelStart({ cwd, onStarted, onError }: { cwd?: string; onStarted: () => void; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState('');
  const [preview, setPreview] = useState<{ repo: string; spec: RunSpec } | undefined>();
  const [busy, setBusy] = useState(false);
  const close = () => { setOpen(false); setPreview(undefined); setFile(''); };
  if (!open) return <button className="parallelopen" onClick={() => setOpen(true)}>Parallel run</button>;
  const read = () => {
    if (!cwd) return;
    setBusy(true);
    previewRun(cwd, file.trim()).then(setPreview).catch((e) => onError((e as Error).message)).finally(() => setBusy(false));
  };
  const start = () => {
    if (!cwd || !preview) return;
    setBusy(true);
    startRun(cwd, preview.spec).then(() => { onStarted(); close(); }).catch((e) => onError((e as Error).message)).finally(() => setBusy(false));
  };
  return (
    <div className="parallelstart">
      <label>Tasks file
        <input value={file} disabled={!cwd} onChange={(e) => { setFile(e.target.value); setPreview(undefined); }} placeholder="tasks.json" />
      </label>
      {!cwd && <p className="hint">Open a session in the repo first.</p>}
      <div className="actions">
        <button onClick={read} disabled={!cwd || !file.trim() || busy}>Read</button>
        <button onClick={close}>Cancel</button>
      </div>
      {preview && (
        <>
          <PreviewLines repo={preview.repo} spec={preview.spec} />
          <button className="primary" onClick={start} disabled={busy}>Start</button>
        </>
      )}
    </div>
  );
}
