// P0.7: Knowl CLI in the scratch repo: store, query, format, timing.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { record, SCRATCH, FIX } from './lib.mjs';

const run = (cmd) => {
  const t = Date.now();
  const r = spawnSync(cmd, { cwd: SCRATCH, shell: true, encoding: 'utf8', input: '', timeout: 120_000 });
  return { ms: Date.now() - t, code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};
const log = [];
const step = (label, cmd) => { const r = run(cmd); log.push({ label, cmd, ...r }); return r; };

const init = step('init', 'knowl init');
const store = step('store', 'knowl store --category decision --title "Upload retry policy" --provenance observed "upload() retries flakyPut() at most 5 attempts, then rethrows the last error."');
const q = [];
for (let i = 0; i < 5; i++) q.push(step(`query${i}`, 'knowl query "upload retry" --limit 5'));
const s = [];
for (let i = 0; i < 5; i++) s.push(step(`status${i}`, 'knowl status')); // cheap read call, for a second timing baseline
const avg = (a) => Math.round(a.reduce((x, r) => x + r.ms, 0) / a.length);
const hit = /Upload retry policy|max(imum)? 5|5 attempts/i.test(q[0].out);
const jsonish = (() => { try { JSON.parse(q[0].out); return true; } catch { return false; } })();
fs.writeFileSync(path.join(FIX, 'knowl-5.23.1-cli.json'), JSON.stringify(log, null, 1));
record('P0.7', hit && store.code === 0,
  `init_exit=${init.code} init_ms=${init.ms} store_exit=${store.code} store_ms=${store.ms} query_hit=${hit} query_avg_ms=${avg(q)} query_ms=${q.map((r) => r.ms)} status_avg_ms=${avg(s)} ` +
  `query_output_is_json=${jsonish} query_head=${JSON.stringify(q[0].out.slice(0, 200))} init_out=${JSON.stringify((init.out + init.err).slice(0, 150))}`);
