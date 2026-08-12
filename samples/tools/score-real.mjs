// Score the tool against REAL approved TTB labels.
//
// The ground truth is structural, not hand-transcribed: every COLA in
// samples/real/ was APPROVED by TTB, so its government warning is compliant.
// Therefore any warning FAILURE reported here is a false rejection — the
// costliest error this tool can make — measured on real submitted artwork
// instead of our own renders.
//
// "unreadable" / "check manually" is NOT counted as a failure: degrading to a
// human check is the designed-safe outcome, and on a curved, textured, or
// low-contrast real photo it is often the correct answer.
//
//   node score-real.mjs [baseUrl] [--dir=../real] [--conc=2]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const BASE = argv.find((a) => a.startsWith('http')) ?? 'http://localhost:3000';
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const DIR = path.resolve(__dirname, arg('dir', '../real'));
const CONC = Number(arg('conc', 2));

const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
// has_warning is set by visual inspection in the manifest, never by the tool
// under test — a front label has no warning, so fail_missing there is correct.
const items = manifest.labels.filter((l) => fs.existsSync(path.join(DIR, l.file)) && l.has_warning !== false);
console.log(`${items.length} real approved TTB labels -> ${BASE}`);

async function check(it) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, Math.min(20000, 1500 * 2 ** attempt)));
    try {
      const file = path.join(DIR, it.file);
      const buf = fs.readFileSync(file);
      const fd = new FormData();
      fd.set('image', new File([buf], it.file, { type: it.file.endsWith('.png') ? 'image/png' : 'image/jpeg' }));
      // Only the warning verdict is application-independent, so supply a
      // minimal application and read the warning result alone.
      fd.set('brand_name', it.brand || 'UNKNOWN');
      fd.set('skip_locate', '1');
      const res = await fetch(`${BASE}/api/check`, { method: 'POST', body: fd });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.result) continue;
      return body.result;
    } catch { /* retry */ }
  }
  return null;
}

const results = [];
let i = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (i < items.length) {
    const it = items[i++];
    const r = await check(it);
    if (!r) { results.push({ ...it, outcome: 'error' }); console.log(`  ?? ${it.file} ERROR`); continue; }
    const v = r.warning.verdict;
    const failed = v.startsWith('fail');
    const outcome = failed ? 'false_rejection' : v === 'unreadable' ? 'safely_degraded' : 'pass';
    results.push({ ...it, verdict: v, overall: r.overall, outcome, ms: r.ms });
    const tag = failed ? '!! FALSE REJECTION' : outcome === 'safely_degraded' ? '~  check-manually' : 'ok';
    console.log(`  ${tag.padEnd(20)} ${it.file.padEnd(28)} ${v}`);
    if (failed) console.log(`       note: ${(r.warning.notes[0] || '').slice(0, 130)}`);
  }
}));

const n = (o) => results.filter((r) => r.outcome === o).length;
const scored = results.length - n('error');
console.log(`\n=== REAL APPROVED TTB LABELS ===`);
console.log(`${n('pass')}/${scored} passed clean · ${n('safely_degraded')} degraded to check-manually · ${n('false_rejection')} FALSE REJECTIONS · ${n('error')} errors`);
if (scored) console.log(`false-rejection rate on real approved labels: ${((n('false_rejection') / scored) * 100).toFixed(1)}%`);

fs.writeFileSync(path.resolve(__dirname, '../../docs/real-labels.json'), JSON.stringify({
  source: manifest.source,
  ground_truth: manifest.ground_truth,
  scored,
  passed_clean: n('pass'),
  safely_degraded: n('safely_degraded'),
  false_rejections: n('false_rejection'),
  errors: n('error'),
  results,
}, null, 2));
console.log('docs/real-labels.json written');
