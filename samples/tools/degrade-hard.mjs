// Harder photo abuse than degrade.mjs: creases, a torn corner, bottle
// curvature, a hand occluding part of the label, low light, hard shadow,
// heavy defocus, and real JPEG q35 artifacts. Renders each base label under
// each condition, then checks every image against the DEPLOYED app and scores
// the one thing that matters: did a clean label ever get asserted as failing?
//
// Images are regenerable and gitignored; the scored summary is committed to
// docs/degraded-hard.json.
//
// Run from samples/tools:  node degrade-hard.mjs [baseUrl]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), '..', '..');
const OUT = path.join(ROOT, 'samples', 'degraded-hard');
const BASE = process.argv[2] ?? 'https://labelcheck-production-8f22.up.railway.app';
fs.mkdirSync(OUT, { recursive: true });

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'manifest.json'), 'utf8'));
const LABELS = ['clean-match', 'wine-label', 'word-swap', 'title-case-prefix', 'small-warning'];

// What the shipped pipeline must produce on the pristine image.
const EXPECTED = {
  'clean-match': 'clean',
  'wine-label': 'clean',
  'word-swap': 'warning_failure',
  'title-case-prefix': 'warning_failure',
  'small-warning': 'clean',
};

const shade = (css) => `<div style="position:absolute;inset:0;pointer-events:none;${css}"></div>`;

const CONDITIONS = {
  // Paper folded and re-flattened: alternating light/dark bands + slight shear.
  crease: {
    wrap: 'transform: skewY(-1.2deg) scale(0.97); filter: contrast(0.92);',
    overlay: shade(`background:repeating-linear-gradient(103deg, rgba(0,0,0,.20) 0 2px, rgba(255,255,255,.16) 2px 7px, rgba(0,0,0,0) 7px 62px);`)
      + shade(`background:linear-gradient(178deg, rgba(0,0,0,.14) 0 18%, rgba(255,255,255,.10) 30%, rgba(0,0,0,.16) 55%, rgba(255,255,255,.08) 78%, rgba(0,0,0,.12) 100%);`),
  },
  // A torn-away corner — part of the label is simply gone.
  torn: {
    wrap: 'clip-path: polygon(0 0, 100% 0, 100% 63%, 86% 71%, 92% 79%, 74% 88%, 80% 96%, 0 100%); filter: contrast(0.95);',
    overlay: shade(`background:linear-gradient(200deg, rgba(0,0,0,0) 60%, rgba(0,0,0,.18) 100%);`),
  },
  // Wrapped on a bottle: horizontal compression at the edges + curve shading.
  curved: {
    wrap: 'transform: perspective(760px) rotateY(24deg) scale(0.9);',
    overlay: shade(`background:linear-gradient(90deg, rgba(0,0,0,.34) 0%, rgba(0,0,0,.05) 22%, rgba(255,255,255,.20) 52%, rgba(0,0,0,.10) 78%, rgba(0,0,0,.38) 100%);`),
  },
  // A thumb over the lower-left, near the warning block.
  occluded: {
    wrap: 'filter: contrast(0.95);',
    overlay: `<div style="position:absolute;left:-6%;bottom:-4%;width:34%;height:30%;border-radius:48% 52% 40% 60%/60% 45% 55% 40%;background:linear-gradient(140deg,#c39070,#9d6a4e);box-shadow:0 0 24px rgba(0,0,0,.4);"></div>`,
  },
  // Shot in a dim warehouse aisle.
  lowlight: { wrap: 'filter: brightness(0.42) contrast(1.12) saturate(0.8);', overlay: '' },
  // Hard shadow of the agent/phone falling across the label.
  shadow: {
    wrap: 'filter: contrast(0.95);',
    overlay: shade(`background:linear-gradient(118deg, rgba(0,0,0,0) 34%, rgba(0,0,0,.55) 36%, rgba(0,0,0,.5) 68%, rgba(0,0,0,0) 70%);`),
  },
  // Badly out of focus — well past the gentle 1.3px of the first set.
  heavyblur: { wrap: 'filter: blur(2.6px) contrast(0.85) brightness(1.06);', overlay: '' },
  // Emailed phone photo: real JPEG artifacts at q35, downscaled.
  jpeg: { wrap: 'transform: scale(0.62); filter: contrast(0.93);', overlay: '', jpeg: 35 },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 1120 } });
const made = [];
for (const label of LABELS) {
  const src = path.join(ROOT, 'samples', 'labels', `${label}.png`);
  const b64 = fs.readFileSync(src).toString('base64');
  for (const [cond, cfg] of Object.entries(CONDITIONS)) {
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#6b6f76;display:flex;align-items:center;justify-content:center;height:1120px">
      <div id="shot" style="position:relative;width:740px;${cfg.wrap}">
        <img src="data:image/png;base64,${b64}" style="display:block;width:100%">
        ${cfg.overlay}
      </div></body></html>`);
    const ext = cfg.jpeg ? 'jpg' : 'png';
    const file = path.join(OUT, `${label}--${cond}.${ext}`);
    await page.locator('#shot').screenshot({ path: file, type: cfg.jpeg ? 'jpeg' : 'png', ...(cfg.jpeg ? { quality: cfg.jpeg } : {}) });
    made.push({ label, cond, file, expected: EXPECTED[label] });
  }
}
await browser.close();
console.log(`rendered ${made.length} hard-degraded images`);

// ---- check every one against the deployed app ----
const fieldsFor = (name) => manifest.labels.find((l) => l.name === name).fields;
async function check(item) {
  const fd = new FormData();
  const buf = fs.readFileSync(item.file);
  fd.set('image', new File([buf], path.basename(item.file), { type: item.file.endsWith('.jpg') ? 'image/jpeg' : 'image/png' }));
  for (const [k, v] of Object.entries(fieldsFor(item.label))) fd.set(k, v);
  const res = await fetch(`${BASE}/api/check`, { method: 'POST', body: fd });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.result) return { ...item, file: undefined, outcome: 'error', detail: body?.error ?? `HTTP ${res.status}` };
  const r = body.result;
  const overall = r.overall;
  const wv = r.warning.verdict;
  // The unforgivable error: a compliant label asserted as a warning failure.
  const falseRejection = item.expected === 'clean' && overall === 'warning_failure';
  // A genuinely bad label that quietly passes is the other direction.
  const missedViolation = item.expected === 'warning_failure' && !wv.startsWith('fail') && wv !== 'unreadable';
  const exact = overall === item.expected;
  const safe = !falseRejection && !missedViolation;
  return { ...item, file: undefined, overall, warning: wv, exact, safe, falseRejection, missedViolation };
}

const results = [];
const queue = [...made];
async function worker() {
  while (queue.length) {
    const it = queue.shift();
    const r = await check(it);
    results.push(r);
    const tag = r.outcome === 'error' ? `ERROR ${r.detail}` : `${r.overall}/${r.warning}${r.falseRejection ? '  ** FALSE REJECTION **' : r.missedViolation ? '  ** MISSED VIOLATION **' : r.exact ? '' : '  (safely degraded)'}`;
    console.log(`[${results.length}/${made.length}] ${it.label}--${it.cond} -> ${tag}`);
  }
}
await Promise.all(Array.from({ length: 4 }, worker));

const byCond = {};
for (const c of Object.keys(CONDITIONS)) {
  const rows = results.filter((r) => r.cond === c);
  byCond[c] = {
    n: rows.length,
    exact: rows.filter((r) => r.exact).length,
    safe: rows.filter((r) => r.safe).length,
    false_rejections: rows.filter((r) => r.falseRejection).length,
    missed_violations: rows.filter((r) => r.missedViolation).length,
    errors: rows.filter((r) => r.outcome === 'error').length,
  };
}
const summary = {
  measured_at: new Date().toISOString(),
  base: BASE,
  note: 'Harder photo abuse than samples/degraded: creases, torn corner, bottle curvature, hand occlusion, low light, hard shadow, heavy defocus, JPEG q35. Images regenerable via samples/tools/degrade-hard.mjs (gitignored).',
  n: results.length,
  exact: results.filter((r) => r.exact).length,
  safe: results.filter((r) => r.safe).length,
  false_rejections: results.filter((r) => r.falseRejection).length,
  missed_violations: results.filter((r) => r.missedViolation).length,
  errors: results.filter((r) => r.outcome === 'error').length,
  by_condition: byCond,
};
fs.writeFileSync(path.join(ROOT, 'docs', 'degraded-hard.json'), JSON.stringify({ summary, results }, null, 2));
console.log('\n=== HARD DEGRADATION ===');
console.log(`${summary.exact}/${summary.n} exact · ${summary.safe}/${summary.n} safe · ${summary.false_rejections} FALSE REJECTIONS · ${summary.missed_violations} missed violations · ${summary.errors} errors`);
for (const [c, s] of Object.entries(byCond)) console.log(`  ${c.padEnd(10)} exact ${s.exact}/${s.n}  safe ${s.safe}/${s.n}  falseRej ${s.false_rejections}  missed ${s.missed_violations}`);
console.log('\ndocs/degraded-hard.json written');
