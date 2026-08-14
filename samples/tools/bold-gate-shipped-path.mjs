// Does a candidate demo image resolve the BOLD GATE reliably, through the path
// the app actually runs?
//
// Why this exists: clean-match--glare2 was picked with two instruments, and
// neither of them measured the thing that decides the card. bold-gate-rescore
// measures the WHOLE image at 3x with a forced "bold" advisory; the live
// stability runs measured the WARNING VERDICT and the model's bold ADVISORY.
// The shipped gate does neither — it crops to the LOCATED WARNING BAND, and
// that band is a model output that moves between runs. On production the same
// card came back amber on one run and green on the next: band [895,1000] one
// time, a tighter band the next, different crop, measurement tips over.
//
// So this harness reproduces the shipped path, band variance included:
//   1. call /api/locate N times to collect the bands the locator ACTUALLY
//      produces for this image — not one band, the spread
//   2. for each band, crop it exactly as lib/boldMeasure.ts does (±1.5% pad,
//      3x smooth upscale, 5th-95th percentile contrast stretch)
//   3. OCR the crop for the prefix and a body reference word, measure stroke
//      width / ink density / cap height, and run the SHIPPED applyBoldGate
//
// A candidate passes only if EVERY band it produces resolves to "bold". One
// "human" in four is a card that asks a 50-year-old agent to confirm bold half
// the times they click it, which is the complaint this whole exercise started
// from.
//
// The measurement recipe is copied from lib/boldMeasure.ts and must stay
// identical to it. Do not "improve" it here to make a candidate pass: the
// gate's zero-confident-mistakes evidence (rubric C9) is tied to this exact
// pre-processing, and a harness that measures something else is how the last
// pick got through.
//
//   node bold-gate-shipped-path.mjs --base=http://localhost:3011 --runs=4 \
//        clean-match--glare2.png clean-match--dark1.png
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createWorker } from 'tesseract.js';
import { applyBoldGate } from '../../lib/compare/boldGate.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const a = argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split('=')[1] : d;
};
const BASE = arg('base', 'http://localhost:3011');
const RUNS = Number(arg('runs', 4));
const ADVISORY = arg('advisory', 'bold'); // the gate's permissive branch
const files = argv.filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('name at least one image under samples/robustness or samples/labels');
  process.exit(1);
}

const resolveImage = (name) => {
  for (const dir of ['robustness', 'labels', 'demo', path.join('batch', 'images')]) {
    const p = path.join(ROOT, 'samples', dir, name);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`image not found: ${name}`);
};

/** The band the locator returns, once per call — this is what varies. */
async function locateBand(buf) {
  const fd = new FormData();
  fd.set('image', new Blob([buf], { type: 'image/png' }), 'x.png');
  const res = await fetch(`${BASE}/api/locate`, { method: 'POST', body: fd });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const body = await res.json().catch(() => null);
  return { band: body?.bands?.warning ?? null };
}

// Pixel maths, evaluated in the page — character-for-character the functions in
// lib/boldMeasure.ts (that file is "use client" and cannot be imported here).
const MEASURE_FN = `
function lumRows(ctx,x0,y0,w,h){const d=ctx.getImageData(x0,y0,w,h).data;const rows=[];for(let y=0;y<h;y++){const row=new Float32Array(w);for(let x=0;x<w;x++){const i=(y*w+x)*4;row[x]=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];}rows.push(row);}return rows;}
function modalBg(rows){const hist=new Array(10).fill(0);for(const row of rows)for(const v of row)hist[Math.min(9,Math.floor(v/25.6))]++;return hist.indexOf(Math.max(...hist))*25.6+12.8;}
function measureBox(rows,bg){if(!rows.length)return null;const h=rows.length,w=rows[0].length;
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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
const worker = await createWorker('eng');
const tmp = path.join(__dirname, '_shippedpath.png');

/** Steps 1-2 of measureBoldSignals: crop the band, upscale, stretch. */
async function prepCrop(b64, band) {
  return page.evaluate(async ({ b64, band }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await new Promise((r) => { img.onload = r; img.onerror = r; });
    if (!img.naturalWidth) return null;
    const W = img.naturalWidth, H = img.naturalHeight;
    const topF = Math.max(0, band[0] / 1000 - 0.015);
    const botF = Math.min(1, band[1] / 1000 + 0.015);
    const y0 = Math.round(topF * H), ch = Math.round((botF - topF) * H);
    if (ch < 4 || W < 8) return null;
    const S = 3;
    const c = document.createElement('canvas');
    c.width = W * S; c.height = ch * S;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, y0, W, ch, 0, 0, c.width, c.height);
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
  }, { b64, band });
}

/** Steps 3-4: OCR for the two words, then measure both boxes. */
async function signalsFor(cropB64) {
  fs.writeFileSync(tmp, Buffer.from(cropB64, 'base64'));
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
  if (!prefix || !body) return { signals: null, why: 'OCR found no prefix/body pair in the crop' };

  const signals = await page.evaluate(async ({ b64, prefix, body, MEASURE_FN }) => {
    eval(MEASURE_FN);
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await new Promise((r) => { img.onload = r; img.onerror = r; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const crop = (b) => {
      const x0 = Math.max(0, b.x0 - 2), y0 = Math.max(0, b.y0 - 2);
      const w = Math.min(b.x1 - b.x0 + 4, c.width - x0);
      const h = Math.min(b.y1 - b.y0 + 4, c.height - y0);
      if (w < 4 || h < 4) return null;
      return lumRows(ctx, x0, y0, w, h);
    };
    const bodyRows = crop(body), prefRows = crop(prefix);
    if (!bodyRows || !prefRows) return null;
    const bg = modalBg(bodyRows);
    const bm = measureBox(bodyRows, bg), pm = measureBox(prefRows, bg);
    if (!bm || !pm) return null;
    return {
      swRatio: pm.sw / bm.sw,
      densRatio: pm.inkFrac / bm.inkFrac,
      sizeRatio: pm.capH / bm.capH,
      swBodyNativePx: bm.sw / 3,
    };
  }, { b64: cropB64, prefix, body, MEASURE_FN });
  return { signals, why: signals ? '' : 'boxes too small to measure' };
}

console.log(`shipped-path bold gate · ${RUNS} locate calls per image · advisory forced "${ADVISORY}"`);
console.log(`locator: ${BASE}/api/locate\n`);

const summary = [];
for (const name of files) {
  const file = resolveImage(name);
  const buf = fs.readFileSync(file);
  const b64 = buf.toString('base64');
  const outcomes = [];
  for (let i = 0; i < RUNS; i++) {
    const { band, error } = await locateBand(buf);
    if (error) { outcomes.push({ verdict: 'locate-failed', note: error }); continue; }
    if (!band) { outcomes.push({ verdict: 'human', note: 'no warning band returned' }); continue; }
    const crop = await prepCrop(b64, band);
    if (!crop) { outcomes.push({ verdict: 'human', band, note: 'crop failed' }); continue; }
    const { signals, why } = await signalsFor(crop);
    const verdict = applyBoldGate(signals, ADVISORY);
    outcomes.push({
      verdict, band,
      note: signals
        ? `sw=${signals.swRatio.toFixed(2)} dens=${signals.densRatio.toFixed(2)} size=${signals.sizeRatio.toFixed(2)} bodyPx=${signals.swBodyNativePx.toFixed(1)}`
        : why,
    });
  }
  const bold = outcomes.filter((o) => o.verdict === 'bold').length;
  summary.push({ name, bold, of: outcomes.length });
  console.log(`${name}`);
  for (const o of outcomes) {
    console.log(`   band ${(o.band ? `${o.band[0]}-${o.band[1]}` : '—').padEnd(11)} -> ${o.verdict.padEnd(12)} ${o.note}`);
  }
  console.log(`   ${bold}/${outcomes.length} resolved "bold"${bold === outcomes.length ? '  <- reliable' : '  <- asks for a human glance some of the time'}\n`);
}

await worker.terminate();
await browser.close();
try { fs.unlinkSync(tmp); } catch { /* already gone */ }

console.log('summary');
for (const s of summary) console.log(`  ${s.name.padEnd(34)} ${s.bold}/${s.of}`);
