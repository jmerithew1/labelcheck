// Re-score the bold check through the SHIPPED gate, offline, at zero API cost.
//
// Why: docs/robustness-matrix.json reports 56 of 61 missed violations as bold
// failures — but that harness reads the RAW model advisory returned by
// /api/check. The product never shows a user that value. Both shipped
// surfaces (SingleCheck.tsx:114, BatchReview.tsx:433) first measure the pixels
// with measureBoldSignals() and then run applyBoldGate(), which is far
// stricter than the advisory alone:
//
//   swRatio >= 1.225 && densRatio >= 1.0 && ai === "bold"  -> "bold"   (green)
//   swRatio <= 0.875 && densRatio <= 1.3                   -> "not_bold" (orange)
//   otherwise                                              -> "human"   (orange)
//
// The decisive asymmetry: the "not_bold" branch never consults the model, and
// the "bold" branch requires the MEASUREMENT to agree. So a wrong "bold"
// advisory can only reach a green check if the pixels independently measure
// heavier too. That makes the question answerable without a single API call —
// measure the images already on disk and count how many non-bold labels could
// even reach the green branch, assuming the model is wrong every time
// (worst case).
//
// Measurement mirrors samples/tools/bold-multisignal-r2.mjs, which is where
// these choices earned their validation numbers: 3x smooth upscale + contrast
// stretch, OCR for the prefix and a body reference word, then stroke-width and
// ink-density on both boxes.
//
//   node bold-gate-rescore.mjs [--labels=a,b] [--limit=N]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createWorker } from 'tesseract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const IMG = path.join(ROOT, 'samples', 'robustness');
const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const LIMIT = Number(arg('limit', 0));

// The frozen shipped thresholds — imported by value so this harness cannot
// drift from lib/compare/boldGate.ts without the mismatch being visible here.
const GATE = { swHi: 1.225, swLo: 0.875, dHi: 1.0, dLo: 1.3, sizeMin: 0.6, sizeMax: 1.7 };

function applyBoldGate(s, ai) {
  if (!s) return 'human';
  const { swRatio, densRatio, sizeRatio } = s;
  if (![swRatio, densRatio, sizeRatio].every(Number.isFinite)) return 'human';
  if (sizeRatio < GATE.sizeMin || sizeRatio > GATE.sizeMax) return 'human';
  if (swRatio >= GATE.swHi && densRatio >= GATE.dHi && ai === 'bold') return 'bold';
  if (swRatio <= GATE.swLo && densRatio <= GATE.dLo) return 'not_bold';
  return 'human';
}

// Pixel helpers, evaluated inside the browser page (identical maths to
// lib/boldMeasure.ts — that file is "use client" and cannot be imported here).
const MEASURE_FN = `
function lumRows(ctx,x0,y0,w,h){const d=ctx.getImageData(x0,y0,w,h).data;const rows=[];for(let y=0;y<h;y++){const row=new Float32Array(w);for(let x=0;x<w;x++){const i=(y*w+x)*4;row[x]=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];}rows.push(row);}return rows;}
function modalBg(rows){const hist=new Array(10).fill(0);for(const row of rows)for(const v of row)hist[Math.min(9,Math.floor(v/25.6))]++;return hist.indexOf(Math.max(...hist))*25.6+12.8;}
function measure(rows,bg){if(!rows.length)return null;const h=rows.length,w=rows[0].length;
const ink=rows.map(r=>Array.from(r,v=>Math.abs(v-bg)>55));
const perRow=ink.map(r=>r.reduce((a,b)=>a+(b?1:0),0));
const act=perRow.map((n,y)=>(n>w*0.02?y:-1)).filter(y=>y>=0);
if(act.length<2)return null;
const capH=act[act.length-1]-act[0]+1;let inkPx=0,totPx=0;
for(const y of act){inkPx+=perRow[y];totPx+=w;}
const runH=ink.map(row=>{const out=new Int16Array(w);let x=0;while(x<w){if(!row[x]){x++;continue;}let e=x;while(e<w&&row[e])e++;for(let i=x;i<e;i++)out[i]=e-x;x=e;}return out;});
const runV=[];for(let y=0;y<h;y++)runV.push(new Int16Array(w));
for(let x=0;x<w;x++){let y=0;while(y<h){if(!ink[y][x]){y++;continue;}let e=y;while(e<h&&ink[e][x])e++;for(let i=y;i<e;i++)runV[i][x]=e-y;y=e;}}
const widths=[];for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(ink[y][x])widths.push(Math.min(runH[y][x],runV[y][x]));
if(widths.length<20)return null;widths.sort((a,b)=>a-b);
return {capH,inkFrac:inkPx/totPx,sw:widths[Math.floor(widths.length/2)]};}
`;

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'manifest.json'), 'utf8'));
// Only labels whose defect IS the bold prefix can answer this question.
const boldDefect = new Set(manifest.labels.filter((l) => /non-bold/.test(l.name)).map((l) => l.name));
const only = arg('labels', '');
const wanted = only ? new Set(only.split(',')) : boldDefect;

let files = fs.readdirSync(IMG).filter((f) => /\.(png|jpg)$/.test(f))
  .filter((f) => wanted.has(f.split('--')[0]));
if (LIMIT) files = files.slice(0, LIMIT);
console.log(`bold-gate re-score: ${files.length} images (labels: ${[...wanted].join(', ')})`);
console.log('measuring pixels only — zero API calls\n');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
const worker = await createWorker('eng');
const tmp = path.join(IMG, '_gatecrop.png');

/** Whole-image crop + 3x upscale + contrast stretch, then OCR for the words. */
async function signalsFor(file) {
  const b64 = fs.readFileSync(file).toString('base64');
  const mime = file.endsWith('.jpg') ? 'jpeg' : 'png';
  const prep = await page.evaluate(async ({ b64, mime }) => {
    const img = new Image();
    img.src = `data:image/${mime};base64,` + b64;
    await new Promise((r) => { img.onload = r; img.onerror = r; });
    if (!img.naturalWidth) return null;
    const S = 3;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth * S; c.height = img.naturalHeight * S;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const lums = new Float32Array(d.data.length / 4);
    for (let i = 0, p = 0; i < d.data.length; i += 4, p++)
      lums[p] = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
    const sorted = Float32Array.from(lums).sort();
    const lo = sorted[Math.floor(sorted.length * 0.05)], hi = sorted[Math.floor(sorted.length * 0.95)];
    const span = Math.max(1, hi - lo);
    for (let i = 0, p = 0; i < d.data.length; i += 4, p++) {
      const v = Math.max(0, Math.min(255, ((lums[p] - lo) / span) * 255));
      d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
    }
    ctx.putImageData(d, 0, 0);
    return c.toDataURL('image/png').split(',')[1];
  }, { b64, mime });
  if (!prep) return null;

  fs.writeFileSync(tmp, Buffer.from(prep, 'base64'));
  const { data } = await worker.recognize(tmp, {}, { blocks: true });
  const words = [];
  for (const b of data.blocks ?? [])
    for (const p of b.paragraphs) for (const l of p.lines) for (const w of l.words)
      words.push({ text: w.text.toUpperCase(), ...w.bbox });
  const clean = (t) => t.replace(/[^A-Z0-9]/g, '');
  const prefix = words.find((w) => clean(w.text).startsWith('GOVERNMENT'));
  const body = words.find((w) => clean(w.text).startsWith('ACCORDING'))
    ?? words.find((w) => clean(w.text).startsWith('CONSUMPTION'))
    ?? words.find((w) => clean(w.text).startsWith('BEVERAGES'));
  if (!prefix || !body) return null; // unmeasurable -> the gate says "human"

  return await page.evaluate(async ({ b64, prefix, body, MEASURE_FN }) => {
    eval(MEASURE_FN);
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await new Promise((r) => { img.onload = r; img.onerror = r; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const crop = (b) => {
      const x0 = Math.max(0, b.x0 - 2), y0 = Math.max(0, b.y0 - 2);
      return lumRows(ctx, x0, y0, Math.min(b.x1 - b.x0 + 4, c.width - x0), Math.min(b.y1 - b.y0 + 4, c.height - y0));
    };
    const bodyR = crop(body), prefR = crop(prefix);
    if (!bodyR?.length || !prefR?.length) return null;
    const bg = modalBg(bodyR);
    const bm = measure(bodyR, bg), pm = measure(prefR, bg);
    if (!bm || !pm) return null;
    return {
      swRatio: pm.sw / bm.sw,
      densRatio: pm.inkFrac / bm.inkFrac,
      sizeRatio: pm.capH / bm.capH,
    };
  }, { b64: prep, prefix, body, MEASURE_FN });
}

const rows = [];
let n = 0;
for (const f of files) {
  const label = f.split('--')[0];
  const cond = f.split('--')[1]?.replace(/\.(png|jpg)$/, '') ?? '';
  let s = null;
  try { s = await signalsFor(path.join(IMG, f)); } catch { s = null; }
  // WORST CASE: assume the model wrongly answers "bold" on every one of these
  // non-bold labels. Any image that still fails to reach the green branch is
  // protected by the measurement alone.
  const gate = applyBoldGate(s, 'bold');
  rows.push({ label, cond, ...(s ?? {}), measurable: !!s, gate });
  if (++n % 20 === 0) process.stdout.write(`  ...${n}/${files.length}\n`);
}

await worker.terminate();
await browser.close();
try { fs.unlinkSync(tmp); } catch { /* already gone */ }

const count = (g) => rows.filter((r) => r.gate === g).length;
const greenLeaks = rows.filter((r) => r.gate === 'bold');
console.log('\n=== BOLD GATE, worst case (model wrong on every image) ===');
console.log(`  ${rows.length} non-bold samples measured`);
console.log(`  gate -> "not_bold"  (orange, measurement alone): ${count('not_bold')}`);
console.log(`  gate -> "human"     (orange, routed to a person): ${count('human')}`);
console.log(`  gate -> "bold"      (GREEN — a real silent miss):  ${greenLeaks.length}`);
console.log(`  unmeasurable (-> human): ${rows.filter((r) => !r.measurable).length}`);
if (greenLeaks.length) {
  console.log('\n  images that would reach a green check:');
  for (const r of greenLeaks.slice(0, 20))
    console.log(`    ${r.label}--${r.cond}  sw=${r.swRatio?.toFixed(2)} dens=${r.densRatio?.toFixed(2)} size=${r.sizeRatio?.toFixed(2)}`);
}

fs.writeFileSync(path.join(ROOT, 'docs', 'bold-gate-rescore.json'), JSON.stringify({
  measured_layer: 'shipped_gate (measureBoldSignals + applyBoldGate)',
  note: 'Worst case: aiAdvisory forced to "bold" on every sample, so this is an UPPER BOUND on how many non-bold labels could reach a green check.',
  thresholds: GATE,
  n: rows.length,
  not_bold: count('not_bold'),
  human: count('human'),
  green_leaks: greenLeaks.length,
  unmeasurable: rows.filter((r) => !r.measurable).length,
  rows,
}, null, 2));
console.log('\ndocs/bold-gate-rescore.json written');
