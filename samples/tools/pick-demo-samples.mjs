// Pick the DEMO images the shipped app serves, from the measured degradation
// corpus, at zero API cost.
//
// Why this exists: the demo samples used to be pristine renders, and three of
// the four single-check cards served the *same* PNG — the archetypes came from
// mutating the application data, not the pixels. A reviewer clicking through
// saw four near-identical clean images, which implies the tool was only ever
// tested on perfect inputs and hides the strongest result we have (544 degraded
// images across the brief's three photo conditions, zero false rejections).
//
// The corpus in samples/robustness/ is gitignored (1,360 images, 157 MB), so
// picks are COPIED into tracked directories:
//   samples/demo/          -> single-check cards + download links (new dir)
//   samples/batch/images/  -> the 12 sample-batch images, under their FIXED
//                             names, because samples/batch/batch.csv refers to
//                             them by name and pairs by filename stem.
//
// Every pick is validated against docs/robustness-matrix.json, which holds a
// measured verdict for all 1,360. A pick is only allowed when the degraded
// variant lands on the SAME `overall` and `warning` as that label's pristine
// baseline and scored `safe` — the owner's decision was that the image gets
// visibly worse while the result does not change. Nothing here is chosen by eye.
//
//   node samples/tools/pick-demo-samples.mjs [--dry]
//
// NOTE: run this AFTER samples/tools/render.mjs. render.mjs rewrites
// samples/batch/images/ with pristine labels; this script degrades them again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'samples', 'robustness');
const DEMO = path.join(ROOT, 'samples', 'demo');
const BATCH_IMG = path.join(ROOT, 'samples', 'batch', 'images');
const DRY = process.argv.includes('--dry');

// The route allowlist is /^[a-z0-9-]+\.png$/ (app/api/samples/[name]/route.ts:12
// and app/api/batch-samples/[name]/route.ts:14). "--" is hyphens so source
// names pass as-is, but .jpg is rejected outright — which rules out the whole
// jpeg family (jpeg1-3, combo1-2 render as .jpg). The resolution axis therefore
// comes from `downscale` (small1-3), which is PNG and the smallest in the corpus.
const SERVABLE = /^[a-z0-9-]+\.png$/;
const BANNED_FAMILIES = new Set(['jpeg', 'combined']);

// ---- single-check cards (samples/demo/) ----
// Four distinct LABELS and four distinct condition FAMILIES. The old set reused
// one image three times; swapping that for one uniform degraded look would fix
// nothing, so variety of template matters as much as the degradation.
// Measured caveat that shaped these picks: on a CLEAN label, angle and rotation
// mostly push the verdict to needs_review/unreadable — at a steep angle the
// warning genuinely cannot be read, and the tool is right to say so. Those
// families only preserve a verdict on the warning-FAILURE labels, where the
// defect is still detectable. So the angled sample is a download, not a card.
const DEMO_SPEC = [
  // wine-label--rot1 was tried and rejected: margin 1/3, and on one live run the
  // two warning readings disagreed, putting an amber warning row on the card
  // whose entire claim is "everything lines up".
  //
  // clean-match--rot2 then held this slot and was rejected in turn, for a
  // reason the matrix cannot see: it preserves the VERDICT (clean/pass) but the
  // deskewed letterforms are too soft for the shipped stroke-width gate, which
  // returned "human" — so the card that promises "everything lines up" came
  // back amber, asking for a bold confirmation. A card whose whole claim is
  // "clean" must resolve EVERY check, bold included, so this slot is now picked
  // against samples/tools/bold-gate-rescore.mjs as well as the matrix, and then
  // run live several times over: the matrix is one API call per image and the
  // model varies between runs, which is exactly how a card ends up amber in
  // front of an owner.
  //
  // Measured, four live runs each: overexposed (bright1) was tried and
  // rejected — it clears the gate but its washed-out body text made the two
  // warning readings disagree on one run, downgrading the card to review; blur1
  // failed the same way 1 run in 3. glare2 was 4/4 clean/pass with the widest
  // bold margin measured on this label (sw=2.00, dens=1.86). Glare is rejected
  // for the WARNING card lower down for a different reason — it softens the
  // prefix, and that card's whole defect is prefix CASE — which does not apply
  // to a card that only has to come back clean.
  { card: 'clean',    label: 'clean-match',       family: 'glare',    capCond: 'glare2' },
  { card: 'mismatch', label: 'harbor-gin',        family: 'lowlight'  },
  // glare2 was tried and rejected LIVE, despite margin 2/2 in the matrix: the
  // matrix never calls /api/confirm, so it cannot see the second independent
  // reading. Glare washes out the prefix, the two readings disagreed about it,
  // and the card downgraded from "warning fails" to amber review — killing the
  // one thing it exists to show. This card's defect is letter CASE, so the
  // prefix must stay crisply legible; a colour cast shifts hue without softening
  // letterforms.
  { card: 'warning',  label: 'title-case-prefix', family: 'color-cast' },
  // downscale was tried here and rejected: at 418x610 the warning is marginal
  // enough that the two independent readings disagree, adding a THIRD amber row
  // to a card whose whole job is to demonstrate exactly two field mismatches.
  // It was a margin-1/3 pick — the edge case the margin rule exists to avoid.
  // The low-resolution axis is carried by the batch (batch-rose--small1) instead.
  { card: 'complex',  label: 'batch-vodka',       family: 'shadow'    },
  // the three "Need test files?" download links (SingleCheck.tsx:399)
  // moved off glare when the clean card took it. rotation is the family the
  // clean card vacated, and a download can carry the weaker margin (rot1, 1/3)
  // that a card should not: nothing on screen depends on its verdict.
  { card: 'download', label: 'wine-label',        family: 'rotation', capCond: 'rot1' },
  { card: 'download', label: 'case-diff',         family: 'blur'      },
  // angle only became selectable once the deskew shipped — pre-enhancement no
  // angled variant of this label preserved its verdict past the mildest tilt.
  { card: 'download', label: 'word-drop',         family: 'angle'     },
];

// ---- sample batch (samples/batch/images/) ----
// dst names are fixed by samples/batch/batch.csv — do not change them.
//
// HALF PRISTINE ON PURPOSE. An all-degraded batch measured 11 of 12 rows amber,
// every one of them "bold type still needs a look" — correct behaviour (the
// stroke measurement genuinely cannot resolve bold on a bad photo, and the
// owner's rule is that unresolved bold shows amber, never a green check) but a
// terrible demonstration, and not what a real intake looks like. A 200-300
// label dump is a MIX: mostly decent scans with some bad phone photos. So half
// these rows stay pristine, which also keeps the batch showing both paths —
// bold auto-resolving on the good scans, and the human glance on the rest.
// `pristine: true` copies from samples/labels/ instead of the degraded corpus.
const BATCH_SPEC = [
  { dst: 'clean-match.png', label: 'clean-match', pristine: true },
  { dst: 'wine-label.png', label: 'wine-label', pristine: true },
  { dst: 'stones-throw.png',   label: 'stones-throw',        family: 'glare'       },
  { dst: 'harbor-gin.png',     label: 'harbor-gin',          family: 'shadow'      },
  { dst: 'batch-rye.png', label: 'batch-rye', pristine: true },
  { dst: 'batch-vodka.png',    label: 'batch-vodka',         family: 'rotation'    },
  { dst: 'batch-stout.png', label: 'batch-stout', pristine: true },
  { dst: 'batch-rose.png',     label: 'batch-rose',          family: 'downscale'   },
  { dst: 'case-diff.png', label: 'case-diff', pristine: true },
  { dst: 'case-diff-2.png',    label: 'batch-case-diff',     family: 'lowlight'    },
  { dst: 'warning-fail.png',   label: 'word-swap',           family: 'angle'       },
  { dst: 'brand-mismatch.png', label: 'batch-mismatch-brand', pristine: true },
];

const rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'robustness-matrix.json'), 'utf8')).results;

// Overlay post-enhancement verdicts where we have them. The matrix was scored
// BEFORE the deskew step shipped, so for the 424 images enhancement modifies it
// no longer describes what the app produces — and a demo image must be chosen
// against the pipeline it will actually run through. Enhancement raised
// confirmed-clean on those from 13 to 31, so several angled variants only
// became selectable now.
const abPath = path.join(ROOT, 'docs', 'enhance-ab.json');
let overlaid = 0;
if (fs.existsSync(abPath)) {
  const ab = JSON.parse(fs.readFileSync(abPath, 'utf8'));
  if (ab.status !== 'UNTRUSTWORTHY') {
    const after = new Map();
    for (const r of ab.results ?? []) if (!r.after?.error) after.set(`${r.label}--${r.cond}`, r.after);
    for (const r of rows) {
      const a = after.get(`${r.label}--${r.cond}`);
      if (!a) continue;
      r.overall = a.overall;
      r.warning = a.warning;
      r.safe = !a.falseRejection && !a.silentMiss;
      overlaid++;
    }
  }
}
console.log(`verdicts: ${rows.length} from the matrix, ${overlaid} overlaid with post-enhancement results\n`);

const pristine = {};
for (const r of rows) if (r.cond === 'pristine') pristine[r.label] = r;

/**
 * Choose a condition within `family` that preserves the label's pristine verdict.
 *
 * Margin over severity: the matrix verdict came from ONE API run and the model
 * varies slightly between runs, so a variant that only just survives is a poor
 * bet. Take the top of the contiguous preserving run — the harshest condition
 * whose every milder sibling also preserves — which maximises visible
 * degradation while keeping everything below it as headroom.
 */
function pick(label, family, capCond) {
  const base = pristine[label];
  if (!base) throw new Error(`no pristine baseline for "${label}"`);
  if (BANNED_FAMILIES.has(family)) throw new Error(`family "${family}" renders as .jpg and is unservable`);

  const inFamily = rows
    .filter((r) => r.label === label && r.family === family && r.cond !== 'pristine')
    .sort((a, b) => a.cond.localeCompare(b.cond, undefined, { numeric: true }));
  if (!inFamily.length) throw new Error(`no "${family}" conditions for "${label}"`);

  const preserves = (r) => r.overall === base.overall && r.warning === base.warning && r.safe;

  let chosen = null;
  for (const r of inFamily) {
    if (!preserves(r)) break; // contiguity broken — everything past here is a gamble
    chosen = r;
    // capCond stops at a named severity even when harsher ones also preserve.
    // Used for rotation on the demo card: deskew expands the canvas to avoid
    // clipping corners, so a 15deg tilt costs ~50% more pixels and 1-2s of
    // vision latency against a ~5s bar. 8deg reads as obviously tilted at a
    // fraction of the cost.
    if (capCond && r.cond === capCond) break;
  }
  if (!chosen) {
    const any = inFamily.filter(preserves).map((r) => r.cond);
    throw new Error(
      `"${label}" has no verdict-preserving "${family}" variant at the mildest severity` +
        (any.length ? ` (non-contiguous survivors: ${any.join(', ')})` : ''),
    );
  }
  const runLen = inFamily.findIndex((r) => r.cond === chosen.cond) + 1;
  return { ...chosen, base, margin: runLen, familySize: inFamily.length };
}

function copyOut(srcName, destDir, destName) {
  const src = path.join(SRC, srcName);
  if (!fs.existsSync(src)) throw new Error(`source image missing on disk: ${srcName} (regenerate samples/robustness/)`);
  if (!SERVABLE.test(destName)) throw new Error(`"${destName}" is not servable by the route allowlist`);
  if (DRY) return fs.statSync(src).size;
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, destName));
  return fs.statSync(src).size;
}

const manifest = { generated: new Date().toISOString(), generator: 'samples/tools/pick-demo-samples.mjs', note: 'Every entry was selected because its measured verdict in docs/robustness-matrix.json matches its label pristine baseline. Images degrade; verdicts do not.', single_check: [], batch: [] };
let bytes = 0;
const familiesUsed = { single: new Set(), batch: new Set() };

console.log(`${DRY ? 'DRY RUN — ' : ''}picking demo images from the measured corpus\n`);
console.log('SINGLE-CHECK  (-> samples/demo/)');
for (const spec of DEMO_SPEC) {
  const p = pick(spec.label, spec.family, spec.capCond);
  const name = `${p.label}--${p.cond}.png`;
  bytes += copyOut(name, DEMO, name);
  familiesUsed.single.add(p.family);
  manifest.single_check.push({ card: spec.card, file: name, label: p.label, cond: p.cond, family: p.family, verdict: `${p.overall}/${p.warning}`, margin: `${p.margin}/${p.familySize}` });
  console.log(`  ${spec.card.padEnd(9)} ${name.padEnd(34)} ${p.family.padEnd(12)} ${(p.overall + '/' + p.warning).padEnd(30)} margin ${p.margin}/${p.familySize}`);
}

console.log('\nSAMPLE BATCH  (-> samples/batch/images/, names fixed by batch.csv)');
for (const spec of BATCH_SPEC) {
  if (spec.pristine) {
    const name = `${spec.label}.png`;
    const src = path.join(ROOT, 'samples', 'labels', name);
    if (!fs.existsSync(src)) throw new Error(`pristine source missing: ${name}`);
    if (!DRY) fs.copyFileSync(src, path.join(BATCH_IMG, spec.dst));
    bytes += fs.statSync(src).size;
    const b = pristine[spec.label];
    manifest.batch.push({ file: spec.dst, source: name, label: spec.label, cond: 'pristine', family: 'baseline', verdict: `${b.overall}/${b.warning}` });
    console.log(`  ${spec.dst.padEnd(20)} <- ${name.padEnd(30)} ${'(pristine)'.padEnd(12)} ${(b.overall + '/' + b.warning).padEnd(30)} clean scan`);
    continue;
  }
  const p = pick(spec.label, spec.family);
  const name = `${p.label}--${p.cond}.png`;
  bytes += copyOut(name, BATCH_IMG, spec.dst);
  familiesUsed.batch.add(p.family);
  manifest.batch.push({ file: spec.dst, source: name, label: p.label, cond: p.cond, family: p.family, verdict: `${p.overall}/${p.warning}`, margin: `${p.margin}/${p.familySize}` });
  console.log(`  ${spec.dst.padEnd(20)} <- ${name.padEnd(30)} ${p.family.padEnd(12)} ${(p.overall + '/' + p.warning).padEnd(30)} margin ${p.margin}/${p.familySize}`);
}

// The original complaint was that every sample looked the same. Assert the fix
// rather than trusting it: a grid whose cards all share one family would be a
// new uniform look, not a mix.
const REQUIRED = ['angle', 'rotation', 'lowlight', 'downscale'];
const all = new Set([...familiesUsed.single, ...familiesUsed.batch]);
const missing = REQUIRED.filter((f) => !all.has(f));
const lit = all.has('glare') || all.has('overexposed');
if (familiesUsed.single.size !== DEMO_SPEC.length) {
  const dupes = DEMO_SPEC.length - familiesUsed.single.size;
  throw new Error(`single-check cards reuse ${dupes} condition family/families — the grid must not look uniform`);
}
if (missing.length || !lit) throw new Error(`spread requirement unmet — missing: ${[...missing, ...(lit ? [] : ['glare/overexposed'])].join(', ')}`);

if (!DRY) fs.writeFileSync(path.join(DEMO, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`\nfamilies: ${[...all].sort().join(', ')}`);
console.log(`spread OK — ${DEMO_SPEC.length} single-check (all distinct families) + ${BATCH_SPEC.length} batch, ${(bytes / 1048576).toFixed(2)} MB`);
console.log(DRY ? '\nDRY RUN — nothing written' : '\nsamples/demo/manifest.json written');
