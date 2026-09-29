// Print a compact outline of a fixture; lines containing argv[3] are shown in full (trimmed).
import fs from 'node:fs';
const [f, needle] = process.argv.slice(2);
fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).forEach((l, i) => {
  let m; try { m = JSON.parse(l); } catch { return console.log(i, 'unparsed', l.slice(0, 100)); }
  const c = Array.isArray(m.message?.content) ? m.message.content.map((x) => x.type + (x.name ? ':' + x.name : '')).join(',') : '';
  console.log(i + 1, m.type, m.subtype ?? '', m.hook_event ?? m.hook_name ?? '', c);
  if (needle && l.includes(needle)) console.log('   >>', l.slice(Math.max(0, l.indexOf(needle) - 350), l.indexOf(needle) + 250));
});
