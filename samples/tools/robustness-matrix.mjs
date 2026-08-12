// Large-scale robustness matrix: every ground-truthed label × a wide grid of
// photo-realistic abuse, at several intensities. Ground truth is exact
// because the base labels are generator-rendered, so every verdict can be
// scored — the point is not "accuracy" but the two errors that matter:
//
//   FALSE REJECTION  a compliant label asserted as failing   (unforgivable)
//   MISSED VIOLATION a non-compliant label passing quietly   (serious)
//
// Anything that degrades to "check manually" is SAFE by design.
//
// Images are regenerable and gitignored; the scored summary lands in
// docs/robustness-matrix.json.
//
//   node robustness-matrix.mjs [baseUrl] [--labels=a,b] [--limit=N] [--conc=6]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), '..', '..');
const OUT = path.join(ROOT, 'samples', 'robustness');
fs.mkdirSync(OUT, { recursive: true });
// Default to LOCAL. These harnesses fire hundreds of billed requests; with a
// production URL as the default, running one with no argument would hammer the
// live deployment and spend real money by accident.
const LOCAL_DEFAULT = 'http://localhost:3000';
const argv = process.argv.slice(2);
const BASE = argv.find((a) => a.startsWith('http')) ?? LOCAL_DEFAULT;
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const CONC = Number(arg('conc', 2));
const LIMIT = Number(arg('limit', 0));

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'manifest.json'), 'utf8'));
// Labels with a warning we can score. missing-warning is excluded: "absent"
// is its correct answer and degradation cannot make that more interesting.
const SCOREABLE = manifest.labels
  .filter((l) => l.name !== 'missing-warning')
  .map((l) => l.name);
const only = arg('labels', '');
const LABELS = only ? only.split(',') : SCOREABLE;

// Expected pipeline outcome on the pristine image, from the manifest's own
// ground truth: warning_ok false => the label must fail the warning check.
const expectedFor = (name) => (manifest.labels.find((l) => l.name === name).warning_ok ? 'clean' : 'warning_failure');

const band = (css) => `<div style="position:absolute;inset:0;pointer-events:none;${css}"></div>`;
const thumb = (x, y, w) => `<div style="position:absolute;left:${x}%;top:${y}%;width:${w}%;height:${w * 0.9}%;border-radius:48% 52% 40% 60%/60% 45% 55% 40%;background:linear-gradient(140deg,#c39070,#9d6a4e);box-shadow:0 0 22px rgba(0,0,0,.4)"></div>`;

// ---- the grid: condition family × intensity ----
const CONDITIONS = [];
const add = (name, family, cfg) => CONDITIONS.push({ name, family, ...cfg });

add('pristine', 'baseline', { wrap: '' });
for (const [i, px] of [1.0, 1.8, 2.6, 3.4].entries())
  add(`blur${i + 1}`, 'blur', { wrap: `filter: blur(${px}px) contrast(0.88) brightness(1.05);` });
for (const [i, deg] of [10, 20, 30, 40].entries())
  add(`angle${i + 1}`, 'angle', { wrap: `transform: perspective(820px) rotateY(${deg}deg) rotateX(${Math.round(deg / 3)}deg) scale(${(0.95 - i * 0.04).toFixed(2)});` });
for (const [i, deg] of [3, 8, 15].entries())
  add(`rot${i + 1}`, 'rotation', { wrap: `transform: rotate(${deg}deg) scale(0.88);` });
for (const [i, b] of [0.62, 0.44, 0.3].entries())
  add(`dark${i + 1}`, 'lowlight', { wrap: `filter: brightness(${b}) contrast(1.1) saturate(0.8);` });
add('bright1', 'overexposed', { wrap: 'filter: brightness(1.6) contrast(0.7);' });
add('bright2', 'overexposed', { wrap: 'filter: brightness(2.0) contrast(0.55);' });
for (const [i, q] of [60, 40, 25].entries())
  add(`jpeg${i + 1}`, 'jpeg', { wrap: `transform: scale(${(0.8 - i * 0.12).toFixed(2)});`, jpeg: q });
for (const [i, s] of [0.55, 0.4, 0.28].entries())
  add(`small${i + 1}`, 'downscale', { wrap: `transform: scale(${s});` });
add('glare1', 'glare', { wrap: 'filter: contrast(0.8) brightness(1.12);', overlay: band('background:radial-gradient(ellipse at 30% 26%, rgba(255,255,255,.85) 0%, rgba(255,255,255,0) 46%)') });
add('glare2', 'glare', { wrap: 'filter: contrast(0.68) brightness(1.2);', overlay: band('background:radial-gradient(ellipse at 52% 72%, rgba(255,255,255,.95) 0%, rgba(255,255,255,0) 52%)') });
add('shadow1', 'shadow', { overlay: band('background:linear-gradient(118deg, rgba(0,0,0,0) 34%, rgba(0,0,0,.55) 36%, rgba(0,0,0,.5) 68%, rgba(0,0,0,0) 70%)') });
add('shadow2', 'shadow', { overlay: band('background:linear-gradient(0deg, rgba(0,0,0,.72) 0 38%, rgba(0,0,0,0) 62%)') });
add('crease1', 'crease', { wrap: 'transform: skewY(-1.2deg) scale(0.97);', overlay: band('background:repeating-linear-gradient(103deg, rgba(0,0,0,.20) 0 2px, rgba(255,255,255,.16) 2px 7px, rgba(0,0,0,0) 7px 62px)') });
add('crease2', 'crease', { wrap: 'transform: skewY(2deg) skewX(-1deg) scale(0.95);', overlay: band('background:repeating-linear-gradient(72deg, rgba(0,0,0,.28) 0 3px, rgba(255,255,255,.2) 3px 9px, rgba(0,0,0,0) 9px 40px)') });
add('curved1', 'curvature', { wrap: 'transform: perspective(760px) rotateY(24deg) scale(0.9);', overlay: band('background:linear-gradient(90deg, rgba(0,0,0,.34) 0%, rgba(0,0,0,.05) 22%, rgba(255,255,255,.20) 52%, rgba(0,0,0,.10) 78%, rgba(0,0,0,.38) 100%)') });
add('curved2', 'curvature', { wrap: 'transform: perspective(560px) rotateY(34deg) scale(0.84);', overlay: band('background:linear-gradient(90deg, rgba(0,0,0,.5) 0%, rgba(255,255,255,.24) 50%, rgba(0,0,0,.5) 100%)') });
add('torn1', 'torn', { wrap: 'clip-path: polygon(0 0, 100% 0, 100% 63%, 86% 71%, 92% 79%, 74% 88%, 80% 96%, 0 100%);' });
add('torn2', 'torn', { wrap: 'clip-path: polygon(0 0, 100% 0, 100% 100%, 22% 100%, 30% 92%, 14% 86%, 24% 78%, 0 72%);' });
add('occl1', 'occlusion', { overlay: thumb(-6, 74, 34) });
add('occl2', 'occlusion', { overlay: thumb(58, 80, 38) });
add('noise1', 'sensor-noise', { wrap: 'filter: contrast(1.15) saturate(0.85);', overlay: band("background-image:url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"120\" height=\"120\"><filter id=\"n\"><feTurbulence baseFrequency=\"0.9\" numOctaves=\"3\"/></filter><rect width=\"120\" height=\"120\" filter=\"url(%23n)\" opacity=\"0.42\"/></svg>');background-repeat:repeat;mix-blend-mode:overlay") });
add('cast1', 'color-cast', { wrap: 'filter: sepia(0.55) hue-rotate(-18deg) saturate(1.3) brightness(0.92);' });
add('cast2', 'color-cast', { wrap: 'filter: hue-rotate(180deg) saturate(1.5) brightness(0.9);' });
add('combo1', 'combined', { wrap: 'transform: perspective(820px) rotateY(18deg) scale(0.8); filter: blur(1.4px) brightness(0.7) contrast(1.05);', overlay: band('background:linear-gradient(110deg, rgba(0,0,0,0) 40%, rgba(0,0,0,.45) 44%, rgba(0,0,0,0) 76%)'), jpeg: 50 });
add('combo2', 'combined', { wrap: 'transform: rotate(6deg) scale(0.62); filter: blur(1.1px) brightness(1.35) contrast(0.75);', overlay: band('background:radial-gradient(ellipse at 40% 30%, rgba(255,255,255,.8) 0%, rgba(255,255,255,0) 50%)'), jpeg: 45 });

console.log(`${LABELS.length} labels × ${CONDITIONS.length} conditions = ${LABELS.length * CONDITIONS.length} images`);

// ---- render ----
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 980, height: 1200 } });
const items = [];
for (const label of LABELS) {
  const b64 = fs.readFileSync(path.join(ROOT, 'samples', 'labels', `${label}.png`)).toString('base64');
  for (const c of CONDITIONS) {
    const ext = c.jpeg ? 'jpg' : 'png';
    const file = path.join(OUT, `${label}--${c.name}.${ext}`);
    if (!fs.existsSync(file)) {
      await page.setContent(`<!doctype html><html><body style="margin:0;background:#6b6f76;display:flex;align-items:center;justify-content:center;height:1200px">
        <div id="shot" style="position:relative;width:760px;${c.wrap ?? ''}">
          <img src="data:image/png;base64,${b64}" style="display:block;width:100%">${c.overlay ?? ''}
        </div></body></html>`);
      await page.locator('#shot').screenshot({ path: file, type: c.jpeg ? 'jpeg' : 'png', ...(c.jpeg ? { quality: c.jpeg } : {}) });
    }
    items.push({ label, cond: c.name, family: c.family, file, expected: expectedFor(label) });
  }
}
await browser.close();
console.log(`rendered/reused ${items.length} images`);

// ---- score against the deployed app ----
const fieldsFor = (name) => manifest.labels.find((l) => l.name === name).fields;
async function check(it) {
  // Upstream vision APIs shed load under sustained parallel traffic (529
  // overloaded). A measurement harness that counts those as results produces
  // a beautiful, meaningless score — an all-errors run reads as "0 false
  // rejections". So: retry hard with exponential backoff, and never let an
  // unresolved error masquerade as a verdict.
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, Math.min(30000, 1500 * 2 ** attempt) + Math.random() * 800));
    try {
      const fd = new FormData();
      const buf = fs.readFileSync(it.file);
      fd.set('image', new File([buf], path.basename(it.file), { type: it.file.endsWith('.jpg') ? 'image/jpeg' : 'image/png' }));
      for (const [k, v] of Object.entries(fieldsFor(it.label))) fd.set(k, v);
      // The evidence-band locator plays no part in the verdict being scored,
      // so skipping it removes a third of the model calls (and a third of the
      // cost) from every measurement run.
      fd.set('skip_locate', '1');
      const res = await fetch(`${BASE}/api/check`, { method: 'POST', body: fd });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.result) continue;
      const wv = body.result.warning.verdict;
      const overall = body.result.overall;
      // Record the advisories rather than inferring them from `overall` later.
      // Inferring is how a bold weakness stayed invisible across two campaigns.
      const boldAdvisory = body.result.warning.boldAdvisory;
      // A defect the engine treats as ADVISORY (bold) can never produce a
      // fail_* verdict — that is the design, not a bug. Scoring it identically
      // to a silent pass conflates two very different outcomes: the tool that
      // said nothing, and the tool that put the label in front of a human.
      // Split them, and keep the honest denominator by counting both.
      const notCaught = it.expected === 'warning_failure' && !wv.startsWith('fail') && wv !== 'unreadable';
      const flaggedForHuman = notCaught && overall === 'needs_review';
      return {
        overall, warning: wv, ms: body.ms, boldAdvisory,
        exact: overall === it.expected,
        falseRejection: it.expected === 'clean' && overall === 'warning_failure',
        missedViolation: notCaught,
        // subset of missedViolation: routed to review rather than passed silently
        flaggedNotFailed: flaggedForHuman,
        silentMiss: notCaught && !flaggedForHuman,
      };
    } catch { /* retry */ }
  }
  return { outcome: 'error', detail: 'retries exhausted' };
}

const queue = LIMIT ? items.slice(0, LIMIT) : items;
const queueSize = queue.length; // asserted against the scored count below
const results = [];
let done = 0;
async function worker() {
  while (queue.length) {
    const it = queue.shift();
    const r = await check(it);
    const row = { ...it, file: undefined, ...r };
    row.safe = !row.falseRejection && !row.missedViolation && r.outcome !== 'error';
    results.push(row);
    done++;
    if (row.falseRejection || row.missedViolation) console.log(`  !! ${it.label}--${it.cond} ${row.overall}/${row.warning} ${row.falseRejection ? 'FALSE REJECTION' : 'MISSED VIOLATION'}`);
    if (done % 25 === 0) console.log(`  ...${done} checked`);
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: CONC }, worker));

const agg = (rows) => ({
  n: rows.length,
  exact: rows.filter((r) => r.exact).length,
  safe: rows.filter((r) => r.safe).length,
  false_rejections: rows.filter((r) => r.falseRejection).length,
  missed_violations: rows.filter((r) => r.missedViolation).length,
  // of those, the ones the tool still surfaced to a human vs said nothing about
  flagged_not_failed: rows.filter((r) => r.flaggedNotFailed).length,
  silent_misses: rows.filter((r) => r.silentMiss).length,
  errors: rows.filter((r) => r.outcome === 'error').length,
});
const byFamily = {};
for (const f of [...new Set(items.map((i) => i.family))]) byFamily[f] = agg(results.filter((r) => r.family === f));
const summary = {
  measured_at: new Date().toISOString(), base: BASE,
  // Which layer produced these verdicts. The bold advisory recorded here is
  // the RAW server value; the shipped UI additionally runs the pixel gate in
  // lib/compare/boldGate.ts (see samples/tools/bold-gate-rescore.mjs). Naming
  // the layer stops a future reader assuming this is what a user sees.
  measured_layer: 'api_advisory (/api/check) — NOT the client-side bold gate',
  wall_s: Math.round((Date.now() - t0) / 1000),
  note: 'Robustness matrix: every scoreable ground-truthed label under a grid of photo abuse (blur, angle, rotation, low light, overexposure, JPEG, downscale, glare, shadow, crease, curvature, tear, occlusion, sensor noise, color cast, and combined). Images regenerable via samples/tools/robustness-matrix.mjs (gitignored).',
  ...agg(results), by_family: byFamily,
};
// A run that cannot be trusted must fail LOUDLY rather than score well. This
// harness once reported "0 false rejections · 0 missed violations" — a
// perfect-looking result produced by 120 consecutive HTTP 500s, because every
// errored check simply failed to be counted as a mistake. Two guards:
//   (1) an error rate above 2% invalidates the whole run
//   (2) the scored count must equal the queued count
const errRate = summary.errors / Math.max(1, summary.n);
if (errRate > 0.02) {
  fs.writeFileSync(path.join(ROOT, 'docs', 'robustness-matrix.json'),
    JSON.stringify({ summary: { ...summary, UNTRUSTWORTHY: true }, results }, null, 2));
  console.error(`\n!! RUN NOT TRUSTWORTHY — ${summary.errors}/${summary.n} checks errored (${Math.round(errRate * 100)}%).`);
  console.error('   Refusing to report a score. Fix the server or credentials and re-run.');
  process.exit(1);
}
if (summary.n !== queueSize) {
  console.error(`\n!! COUNT MISMATCH — scored ${summary.n}, queued ${queueSize}. Refusing to report.`);
  process.exit(1);
}

fs.writeFileSync(path.join(ROOT, 'docs', 'robustness-matrix.json'), JSON.stringify({ summary, results }, null, 2));
console.log('\n=== ROBUSTNESS MATRIX ===');
console.log(`${summary.exact}/${summary.n} exact · ${summary.safe}/${summary.n} SAFE · ${summary.false_rejections} false rejections · ${summary.missed_violations} not caught (${summary.silent_misses} SILENT, ${summary.flagged_not_failed} flagged for review) · ${summary.errors} errors · ${summary.wall_s}s`);
for (const [f, s] of Object.entries(byFamily).sort((a, b) => (a[1].safe / a[1].n) - (b[1].safe / b[1].n)))
  console.log(`  ${f.padEnd(13)} safe ${s.safe}/${s.n}  exact ${s.exact}/${s.n}  falseRej ${s.false_rejections}  missed ${s.missed_violations}`);
console.log('\ndocs/robustness-matrix.json written');
