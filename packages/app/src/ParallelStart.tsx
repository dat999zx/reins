import { Fragment, useState } from 'react';
import { showText } from '../../core/src/display.js';
import { previewRun, startRun } from './api.js';
import type { RunSpec } from './parallel.js';

const usd = (n: number) => `$${n}`;

export function PreviewLines({ repo, spec }: { repo: string; spec: RunSpec }) {
  const row = (label: string, value: string | undefined, cmd = false, key = label) => value === undefined ? null : (
    <Fragment key={key}><dt>{label}</dt><dd className={cmd ? 'cmd' : undefined}>{cmd ? <code>{showText(value)}</code> : showText(value)}</dd></Fragment>
  );
  return (
    <div className="preview">
      <p>{showText(spec.title)}</p>
      <dl>
        {row('Repo', repo)}
        {spec.tasks.map((k) => row('Task', [k.name, k.model, k.effort].filter(Boolean).join('  '), false, k.slug))}
        {row('Install', spec.install, true)}
        {row('Gate', spec.gate, true)}
        {row('Retry', spec.gateRetry, true)}
        {row('Reports', spec.reports)}
        {row('Copy', spec.copy.length ? spec.copy.join(', ') : undefined)}
        {row('Cap', spec.capUsd !== undefined ? usd(spec.capUsd) : undefined)}
        {row('Approve', spec.approve)}
      </dl>
      {(spec.install !== undefined || spec.gate !== undefined) && <p>Start runs these commands in a shell.</p>}
    </div>
  );
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
        {!preview && <button onClick={read} disabled={!cwd || !file.trim() || busy}>Read</button>}
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
