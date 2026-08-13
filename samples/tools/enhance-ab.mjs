// A/B the pre-read enhancement (deskew + contrast normalise) against the
// measured baseline in docs/robustness-matrix.json.
//
// The question: angled and rotated compliant labels are SAFE today (zero false
// rejections) but rarely CONFIRMED — 5/56 angled and 5/42 rotated came back
// clean, the rest went amber for a human. Does straightening the image before
// the read convert amber into green?
//
// The ship/no-ship guard is the other direction. An enhancement that makes the
// model *confident about text it is misreading* would raise false rejections or
// lower violation catch, and that trade is strictly bad: a false review costs a
// two-second glance, a false rejection rejects a compliant application. So this
// prints both directions and refuses to recommend on clean% alone.
//
// Enhancement runs by injecting lib/enhance.ts's own function source into the
// page — not a reimplementation. A second copy is exactly how the bold gate
// drifted out of sync with its harness.
//
//   node samples/tools/enhance-ab.mjs [--families=angle,rotation] [--limit=N] [--base=URL]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { enhanceImage } from '../../lib/enhance.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const IMG = path.join(ROOT, 'samples', 'robustness');
const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const FAMILIES = arg('families', 'angle,rotation').split(',');
const LIMIT = Number(arg('limit', 0));
const BASE = arg('base', 'http://localhost:3000');
const CONC = Number(arg('conc', 3));

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'manifest.json'), 'utf8'));
const fieldsFor = (name) => manifest.labels.find((l) => l.name === name).fields;
const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'robustness-matrix.json'), 'utf8')).results;

// --changed scores ONLY the images enhancement actually modifies, using the
// offline skew audit. Enhancement is a byte-identical passthrough whenever no
// rotation fires, so those verdicts cannot change and paying to re-score them
// would be buying a result we already have. 424 of 1,190 are modified.
const CHANGED_ONLY = argv.includes('--changed');
let changed = null;
if (CHANGED_ONLY) {
  const audit = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'enhance-skew-audit.json'), 'utf8')).rows;
  changed = new Set(audit.filter((r) => Math.abs(r.skew ?? 0) >= 0.75).map((r) => `${r.label}--${r.cond}`));
}

const items = baseline
  .filter((r) => (CHANGED_ONLY ? changed.has(`${r.label}--${r.cond}`) : FAMILIES.includes(r.family)))
  .map((r) => ({ ...r, file: path.join(IMG, `${r.label}--${r.cond}.png`) }))
  .filter((r) => fs.existsSync(r.file));
const queue = LIMIT ? items.slice(0, LIMIT) : items;
console.log(`enhance A/B: ${queue.length} images  families=${FAMILIES.join(',')}  base=${BASE}`);
console.log('enhancement = lib/enhance.ts (injected by source, not reimplemented)\n');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
const FN_SRC = enhanceImage.toString();

/** Mirror of lib/downscale.ts prepareImage(): downscale to 1568, then enhance. */
async function enhanceToJpegBase64(file) {
  const b64 = fs.readFileSync(file).toString('base64');
  return await page.evaluate(async ({ b64, FN_SRC }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await new Promise((r) => { img.onload = r; img.onerror = r; });
    if (!img.naturalWidth) return null;
    const maxEdge = 1568;
    const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
    const scale = longEdge > maxEdge ? maxEdge / longEdge : 1;
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const enhance = eval('(' + FN_SRC + ')');
    const out = enhance(ctx.getImageData(0, 0, w, h).data, w, h);
    // Mirror prepareImage exactly: no rotation and no resize means the ORIGINAL
    // bytes are sent, not a JPEG re-encode. Measuring a re-encode the product
    // never performs would be measuring a layer the user never sees.
    if (out.skewDeg === 0 && scale === 1) return { b64: null, skew: 0 };
    if (out.width !== w || out.height !== h) { c.width = out.width; c.height = out.height; }
    ctx.putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
    return { b64: c.toDataURL('image/jpeg', 0.92).split(',')[1], skew: out.skewDeg };
  }, { b64, FN_SRC });
}

async function check(it) {
  const prepped = await enhanceToJpegBase64(it.file);
  if (!prepped) return { error: 'enhance failed' };
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, Math.min(30000, 1500 * 2 ** attempt) + Math.random() * 800));
    try {
      const fd = new FormData();
      fd.set('image', prepped.b64
        ? new File([Buffer.from(prepped.b64, 'base64')], 'x.jpg', { type: 'image/jpeg' })
        : new File([fs.readFileSync(it.file)], path.basename(it.file), { type: 'image/png' }));
      for (const [k, v] of Object.entries(fieldsFor(it.label))) fd.set(k, v);
      fd.set('skip_locate', '1');
      const res = await fetch(`${BASE}/api/check`, { method: 'POST', body: fd });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.result) continue;
      const wv = body.result.warning.verdict;
      const overall = body.result.overall;
      const notCaught = it.expected === 'warning_failure' && !wv.startsWith('fail') && wv !== 'unreadable';
      return {
        overall, warning: wv, skew: prepped.skew,
        falseRejection: it.expected === 'clean' && overall === 'warning_failure',
        missedViolation: notCaught,
        silentMiss: notCaught && overall !== 'needs_review',
      };
    } catch { /* retry */ }
  }
  return { error: 'unresolved after retries' };
}

const results = [];
let done = 0;
async function worker() {
  while (queue.length) {
    const it = queue.shift();
    const r = await check(it);
    results.push({ label: it.label, cond: it.cond, family: it.family, expected: it.expected, before: { overall: it.overall, warning: it.warning }, after: r });
    if (++done % 20 === 0) process.stdout.write(`  ...${done}\n`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
await browser.close();

// ---- self-checks (H1): a run that cannot be trusted must fail loudly ----
const errors = results.filter((r) => r.after.error);
const errRate = errors.length / Math.max(1, results.length);
if (errRate > 0.02) {
  console.error(`\nUNTRUSTWORTHY: ${errors.length}/${results.length} checks errored (${(errRate * 100).toFixed(1)}%).`);
  console.error('Refusing to print a score — an all-errors run once read as a perfect result.');
  fs.writeFileSync(path.join(ROOT, 'docs', 'enhance-ab.json'), JSON.stringify({ status: 'UNTRUSTWORTHY', errors: errors.length, n: results.length, results }, null, 2));
  process.exit(1);
}

const scored = results.filter((r) => !r.after.error);
const compliant = scored.filter((r) => r.expected === 'clean');
const violation = scored.filter((r) => r.expected !== 'clean');
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : 'n/a');

const beforeClean = compliant.filter((r) => r.before.overall === 'clean').length;
const afterClean = compliant.filter((r) => r.after.overall === 'clean').length;
const beforeFR = compliant.filter((r) => r.before.overall === 'warning_failure').length;
const afterFR = compliant.filter((r) => r.after.falseRejection).length;
// Split bold-only defects out of the guard. Bold NEVER hard-fails by design,
// and this harness reads the server verdict — it cannot see the client-side
// stroke-width gate that actually decides those labels. Counting them here
// measures a layer the user never sees, which is the exact error that made the
// bold check look 29% wrong when the shipped gate leaks 1.9%.
//
// Enhancement legitimately moves bold-only labels from "needs_review because
// unreadable" to "clean" — it made the text readable, and the text IS correct;
// the defect is bold. That removes an ACCIDENTAL protection (too blurry to
// read) and hands the job to the designed one. Verified separately, at zero
// API cost: samples/tools/bold-gate-rescore.mjs --enhance still leaks exactly
// 3 of 160 worst case, unchanged, with 16 MORE images measurable than before.
const isBoldOnly = (r) => /non-bold/.test(r.label);
const textViolation = violation.filter((r) => !isBoldOnly(r));
const boldViolation = violation.filter(isBoldOnly);
const wasMissed = (r) => !String(r.before.warning).startsWith('fail') && r.before.warning !== 'unreadable';
const beforeMV = textViolation.filter(wasMissed).length;
const afterMV = textViolation.filter((r) => r.after.missedViolation).length;
const beforeBoldMV = boldViolation.filter(wasMissed).length;
const afterBoldMV = boldViolation.filter((r) => r.after.missedViolation).length;

console.log(`\n=== ENHANCEMENT A/B  (families: ${FAMILIES.join(', ')}) ===`);
console.log(`  scored ${scored.length}  (${errors.length} errors)\n`);
console.log(`  COMPLIANT labels (n=${compliant.length})`);
console.log(`    confirmed clean/green   before ${beforeClean} (${pct(beforeClean, compliant.length)})   after ${afterClean} (${pct(afterClean, compliant.length)})`);
console.log(`    FALSE REJECTIONS        before ${beforeFR}                after ${afterFR}   <- must not rise`);
console.log(`\n  VIOLATION labels (n=${violation.length})`);
console.log(`    violations not caught   before ${beforeMV}                after ${afterMV}   <- must not rise`);
const skews = scored.map((r) => r.after.skew).filter((s) => typeof s === 'number' && s !== 0);
console.log(`\n  rotation applied to ${skews.length}/${scored.length} images` + (skews.length ? `, median ${skews.slice().sort((a, b) => a - b)[skews.length >> 1].toFixed(1)}deg` : ''));

const safe = afterFR <= beforeFR && afterMV <= beforeMV; // bold-only excluded — see note above
const better = afterClean > beforeClean;
console.log(`\n  VERDICT: ${safe ? (better ? 'SHIP — more confirmed clean, no new errors in either direction' : 'NEUTRAL — no regression, but no gain either') : 'DO NOT SHIP — enhancement introduced errors'}`);

fs.writeFileSync(path.join(ROOT, 'docs', 'enhance-ab.json'), JSON.stringify({
  measured_layer: 'shipped_pipeline (prepareImage: downscale + lib/enhance.ts)',
  families: FAMILIES, base: BASE, n: scored.length, errors: errors.length,
  compliant: { n: compliant.length, clean_before: beforeClean, clean_after: afterClean, false_rejections_before: beforeFR, false_rejections_after: afterFR },
  text_violation: { n: textViolation.length, missed_before: beforeMV, missed_after: afterMV },
  bold_only_violation: { n: boldViolation.length, missed_before: beforeBoldMV, missed_after: afterBoldMV, note: 'advisory layer; decided by lib/compare/boldGate.ts client-side, which bold-gate-rescore.mjs --enhance shows unchanged at 3/160 worst case' },
  verdict: safe ? (better ? 'SHIP' : 'NEUTRAL') : 'DO_NOT_SHIP',
  results,
}, null, 2));
console.log('\ndocs/enhance-ab.json written');
