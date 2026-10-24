import { useState } from 'react';
import { showText } from '../../core/src/display.js';
import { ApiError, post } from './api.js';

/** The workflow's name from its file path: the file name without `.reins.md`. */
export const shareName = (file: string) => (file.split(/[\\/]/).at(-1) ?? '').replace(/\.reins\.md$/, '');

type Bundle = { text: string; ids: string[]; notes: string[] };

/** Asks the server for one file with the mods (and the workflow, when there is one) and hands it to the browser as a download. Returns the words to show. */
async function download(file: string, body: { ids?: string[]; workflow?: { name: string; text: string } }): Promise<string> {
  const r = await post<Bundle>('/api/mods/bundle', body);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([r.text], { type: 'application/json' }));
  a.download = file;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return exportWords(r);
}

/** The words under the Share and Export buttons: how many mods are in the file, then each note of the server (a missing block, a playbook file that is not carried). */
export function exportWords(r: Bundle): string {
  const mods = r.ids.length ? `${r.ids.length} ${r.ids.length === 1 ? 'mod' : 'mods'} in the file` : 'no mods in the file (the blocks it uses ship with Reins)';
  return [mods, ...r.notes].join('. ');
}

/** The workflow menu's entry: the saved workflow and the mods it uses, as one file anyone can import. */
export function ShareButton({ name, text, disabled }: { name: string; text: string; disabled?: boolean }) {
  const [said, setSaid] = useState('');
  const go = () => download(`${name}.reins-mods.json`, { workflow: { name, text } }).then(setSaid, (e) => setSaid(e instanceof ApiError ? e.message : (e as Error).message));
  return (
    <>
      <button onClick={() => void go()} disabled={disabled} title={disabled ? 'Save first: the file holds the saved playbook.' : 'Export this playbook with the mods it uses, as one file.'}>Share</button>
      {said && <span role="status" className="faint">{showText(said)}</span>}
    </>
  );
}

/** Settings: every mod you installed (and every copy of a built-in you made) as one file. At most 20 at a time. */
export function ExportMine({ ids }: { ids: string[] }) {
  const [said, setSaid] = useState('');
  const go = () => download('my-mods.reins-mods.json', { ids: ids.slice(0, 20) }).then(setSaid, (e) => setSaid(e instanceof ApiError ? e.message : (e as Error).message));
  return (
    <>
      <button onClick={() => void go()} disabled={!ids.length}>Export my mods</button>
      {said && <span role="status" className="faint">{showText(said)}</span>}
    </>
  );
}
