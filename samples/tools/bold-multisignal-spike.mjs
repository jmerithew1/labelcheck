// Multi-signal bold verification spike (owner directive: replace the blanket
// human-confirm with a confidence gate — humans see only low-confidence cases).
//
// Signals per warning prefix:
//   S1 stroke width  — median min(horizontal,vertical) ink run length per ink
//                      pixel, normalized by cap height (size-invariant)
//   S2 ink density   — ink fraction ratio prefix/body (the old densitometry)
//   S3 relative size — prefix cap height / body cap height (sanity/normalizer)
//   S4 AI judgment   — Sonnet stroke-weight call (font/style-aware signal)
// Low-quality crops (cap height < 12 px) are re-measured after pre-processing
// (4x upscale + contrast stretch) and the processed measures are used.
//
// Gate: confident-bold / confident-not-bold / human. Thresholds grid-searched
// with a hard constraint of ZERO confident mistakes on scored ground truth;
// coverage (fraction auto-resolved) is what the search maximizes.
//
// Eval sets: the 48-case matrix (regenerated), the 18 ground-truthed sample
// labels, and the 15 degraded images. Run from samples/tools:
//   node bold-multisignal-spike.mjs <outDir>
import { chromium } from 'playwright';
import { createWorker } from 'tesseract.js';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] ?? path.join(process.cwd(), 'multisignal-out');
fs.mkdirSync(OUT, { recursive: true });
const ROOT = path.resolve(process.cwd(), '..', '..');

// ---- API key for the S4 model signal (never printed) ----
function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const env = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  const m = env.match(/ANTHROPIC_API_KEY\s*=\s*"?([^"\r\n]+)/);
  if (!m) throw new Error('no ANTHROPIC_API_KEY');
  return m[1].trim();
}
const KEY = apiKey();

const PREFIX = 'GOVERNMENT WARNING:';
const BODY =
  '(1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.';

function labelHtml({ font, warnPx, prefixWeight, bodyWeight, dark }) {
  const fg = dark ? '#f0ead8' : '#241505';
  const bg = dark ? '#1c2733' : '#f5eeda';
  const line = dark ? '#8a95a3' : '#7a5a34';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#555;}
  #label{width:740px;height:900px;box-sizing:border-box;background:${bg};
    border:6px double ${line};padding:48px 44px;position:relative;
    font-family:${font};color:${fg};text-align:center;}
  .brand{font-size:52px;font-weight:700;margin:30px 0 10px;}
  .class{font-size:24px;font-style:italic;}
  .abv{font-size:20px;font-weight:700;margin-top:26px;}
  .net{font-size:18px;margin-top:6px;}
  .warning{position:absolute;left:44px;right:44px;bottom:34px;text-align:left;
    line-height:1.35;border-top:1px solid ${line};padding-top:12px;
    font-size:${warnPx}px;font-weight:${bodyWeight};}
  </style></head><body><div id="label">
    <div class="brand">OLD TOM DISTILLERY</div>
    <div class="class">Kentucky Straight Bourbon Whiskey</div>
    <div class="abv">45% Alc./Vol. (90 Proof)</div>
    <div class="net">750 mL</div>
    <div class="warning"><span style="font-weight:${prefixWeight};">${PREFIX}</span> ${BODY}</div>
  </div></body></html>`;
}

const BASE = { font: "Georgia,'Times New Roman',serif", warnPx: 13, prefixWeight: 700, bodyWeight: 400, dark: false, scale: 1, jpeg: false };
const FONTS = [
  ['georgia', "Georgia,'Times New Roman',serif"],
  ['arial', 'Arial,Helvetica,sans-serif'],
  ['arial-narrow', "'Arial Narrow',Arial,sans-serif"],
  ['times', "'Times New Roman',serif"],
  ['courier', "'Courier New',monospace"],
  ['verdana', 'Verdana,sans-serif'],
];

const cases = [];
const add = (name, group, over, truthBold, note = '') =>
  cases.push({ kind: 'matrix', name, group, cfg: { ...BASE, ...over }, truthBold, note });
for (const [fname, font] of FONTS) {
  add(`font-${fname}-bold`, 'fonts', { font }, true);
  add(`font-${fname}-reg`, 'fonts', { font, prefixWeight: 400 }, false);
}
for (const px of [10, 13, 18]) {
  add(`size-${px}px-bold`, 'type-size', { warnPx: px }, true);
  add(`size-${px}px-reg`, 'type-size', { warnPx: px, prefixWeight: 400 }, false);
}
for (const scale of [0.5, 1, 2]) {
  add(`res-${scale}x-bold`, 'resolution', { scale }, true);
  add(`res-${scale}x-reg`, 'resolution', { scale, prefixWeight: 400 }, false);
}
add('jpeg-q70-bold', 'jpeg', { jpeg: true }, true);
add('jpeg-q70-reg', 'jpeg', { jpeg: true, prefixWeight: 400 }, false);
add('dark-bg-bold', 'dark-bg', { dark: true }, true);
add('dark-bg-reg', 'dark-bg', { dark: true, prefixWeight: 400 }, false);
for (const [fname, font] of FONTS) {
  add(`semibold-${fname}`, 'semibold-600', { font, prefixWeight: 600 }, true, 'boundary: is 600 "bold type"?');
}
add('allbold-georgia', 'all-bold', { bodyWeight: 700 }, true, 'VIOLATION: body bold');
add('allbold-arial', 'all-bold', { font: 'Arial,Helvetica,sans-serif', bodyWeight: 700 }, true, 'VIOLATION: body bold');
for (const [fname, font] of FONTS) {
  add(`cola-${fname}-bold`, 'cola-typical', { font, jpeg: true, scale: 0.75 }, true);
  add(`cola-${fname}-reg`, 'cola-typical', { font, jpeg: true, scale: 0.75, prefixWeight: 400 }, false);
}

// Real sample labels (ground truth in sidecars) + degraded variants.
const labelsDir = path.join(ROOT, 'samples', 'labels');
const degradedDir = path.join(ROOT, 'samples', 'degraded');
for (const f of fs.readdirSync(labelsDir).filter((f) => f.endsWith('.png'))) {
  const sidecar = JSON.parse(fs.readFileSync(path.join(labelsDir, f.replace(/\.png$/, '.json')), 'utf8'));
  if (sidecar.warning_status === 'absent' || sidecar.warning_missing) continue;
  if (typeof sidecar.warning_prefix_bold !== 'boolean') continue;
  cases.push({ kind: 'file', name: `label-${f.replace(/\.png$/, '')}`, group: 'sample-labels', file: path.join(labelsDir, f), truthBold: sidecar.warning_prefix_bold });
}
if (fs.existsSync(degradedDir)) {
  for (const f of fs.readdirSync(degradedDir).filter((f) => /\.(png|jpg|jpeg)$/i.test(f))) {
    const base = f.replace(/--(blur|tilt|glare)\.\w+$/, '');
    const sidecarPath = path.join(labelsDir, `${base}.json`);
    if (!fs.existsSync(sidecarPath)) continue;
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    if (typeof sidecar.warning_prefix_bold !== 'boolean') continue;
    cases.push({ kind: 'file', name: `degraded-${f.replace(/\.\w+$/, '')}`, group: 'degraded', file: path.join(degradedDir, f), truthBold: sidecar.warning_prefix_bold });
  }
}
console.log(`${cases.length} cases`);

// ---- S4: model stroke-weight judgment via REST (no SDK dependency here) ----
async function aiJudgment(b64, mime) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 200,
        tools: [{
          name: 'record_warning_typography',
          description: "Record the typography of the government warning statement's first two words.",
          input_schema: {
            type: 'object',
            properties: {
              prefix_weight: {
                type: 'string',
                enum: ['heavier', 'same', 'lighter', 'no_warning_present'],
                description: "Compare the STROKE THICKNESS of the letters in the warning statement's first two words against the stroke thickness of the rest of the warning paragraph on the same label. 'heavier' only if the strokes are visibly thicker (bold). ALL-CAPS or larger size alone is NOT heavier — judge stroke weight only.",
              },
            },
            required: ['prefix_weight'],
          },
        }],
        tool_choice: { type: 'tool', name: 'record_warning_typography' },
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: `image/${mime}`, data: b64 } },
          { type: 'text', text: 'Record the typography of the government warning prefix on this label.' },
        ] }],
      }),
    });
    if (!res.ok) return 'unclear';
    const body = await res.json();
    const tu = (body.content ?? []).find((b) => b.type === 'tool_use');
    const w = tu?.input?.prefix_weight;
    return w === 'heavier' ? 'bold' : w === 'same' || w === 'lighter' ? 'not_bold' : 'unclear';
  } catch {
    return 'unclear';
  }
}

// ---- pixel measurement (canvas in a Playwright page) ----
const browser = await chromium.launch();
const worker = await createWorker('eng');
const measurePage = await browser.newPage();

// Measures stroke width, ink fraction, cap height for a word box — raw and,
// when the raw cap height is small, on a pre-processed (4x lanczos-ish
// upscale + contrast stretch) copy of the crop.
async function pixelSignals(file, mime, prefixBox, bodyBox) {
  const b64 = fs.readFileSync(file).toString('base64');
  return await measurePage.evaluate(async ({ b64, mime, prefixBox, bodyBox }) => {
    const img = new Image();
    img.src = `data:image/${mime};base64,` + b64;
    await new Promise((r) => (img.onload = r));
    const full = document.createElement('canvas');
    full.width = img.naturalWidth; full.height = img.naturalHeight;
    full.getContext('2d').drawImage(img, 0, 0);

    const lumRows = (canvas, x0, y0, w, h) => {
      const d = canvas.getContext('2d').getImageData(x0, y0, w, h).data;
      const rows = [];
      for (let y = 0; y < h; y++) {
        const row = new Float32Array(w);
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          row[x] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        }
        rows.push(row);
      }
      return rows;
    };
    const pad = 2;
    const cropRows = (canvas, box, scale = 1) => {
      const x0 = Math.max(0, (box.x0 - pad) * scale), y0 = Math.max(0, (box.y0 - pad) * scale);
      const w = Math.min(canvas.width - x0, (box.x1 - box.x0 + 2 * pad) * scale);
      const h = Math.min(canvas.height - y0, (box.y1 - box.y0 + 2 * pad) * scale);
      if (w <= 2 || h <= 2) return null;
      return lumRows(canvas, Math.round(x0), Math.round(y0), Math.round(w), Math.round(h));
    };

    const modalBg = (rows) => {
      const hist = new Array(10).fill(0);
      for (const row of rows) for (const v of row) hist[Math.min(9, Math.floor(v / 25.6))]++;
      return hist.indexOf(Math.max(...hist)) * 25.6 + 12.8;
    };

    // Stroke metrics over an ink mask: cap height from active rows, ink
    // fraction, and median min(runH,runV) per ink pixel.
    const measure = (rows, bg) => {
      if (!rows) return null;
      const h = rows.length, w = rows[0].length;
      const ink = rows.map((row) => Array.from(row, (v) => Math.abs(v - bg) > 60));
      const perRow = ink.map((r) => r.reduce((a, b) => a + (b ? 1 : 0), 0));
      const act = perRow.map((n, y) => (n > w * 0.02 ? y : -1)).filter((y) => y >= 0);
      if (act.length < 2) return null;
      const capH = act[act.length - 1] - act[0] + 1;
      let inkPx = 0, totPx = 0;
      for (const y of act) { inkPx += perRow[y]; totPx += w; }
      // horizontal run length per pixel
      const runH = ink.map((row) => {
        const out = new Int16Array(w);
        let x = 0;
        while (x < w) {
          if (!row[x]) { x++; continue; }
          let e = x; while (e < w && row[e]) e++;
          for (let i = x; i < e; i++) out[i] = e - x;
          x = e;
        }
        return out;
      });
      const runV = [];
      for (let y = 0; y < h; y++) runV.push(new Int16Array(w));
      for (let x = 0; x < w; x++) {
        let y = 0;
        while (y < h) {
          if (!ink[y][x]) { y++; continue; }
          let e = y; while (e < h && ink[e][x]) e++;
          for (let i = y; i < e; i++) runV[i][x] = e - y;
          y = e;
        }
      }
      const widths = [];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if (ink[y][x]) widths.push(Math.min(runH[y][x], runV[y][x]));
      if (!widths.length) return null;
      widths.sort((a, b) => a - b);
      const sw = widths[Math.floor(widths.length / 2)];
      return { capH, inkFrac: inkPx / totPx, sw, nsw: sw / capH };
    };

    const measurePair = (canvas, scale) => {
      const bodyR = cropRows(canvas, bodyBox, scale);
      const prefR = cropRows(canvas, prefixBox, scale);
      if (!bodyR || !prefR) return null;
      const bg = modalBg(bodyR);
      const body = measure(bodyR, bg);
      const pref = measure(prefR, bg);
      if (!body || !pref) return null;
      return { pref, body };
    };

    const raw = measurePair(full, 1);
    let processed = null;
    const rawCapH = raw?.pref.capH ?? 0;
    if (rawCapH > 0 && rawCapH < 12) {
      // Pre-processing: 4x smooth upscale + linear contrast stretch.
      const up = document.createElement('canvas');
      up.width = full.width * 4; up.height = full.height * 4;
      const uctx = up.getContext('2d');
      uctx.imageSmoothingEnabled = true;
      uctx.imageSmoothingQuality = 'high';
      uctx.drawImage(full, 0, 0, up.width, up.height);
      const d = uctx.getImageData(0, 0, up.width, up.height);
      const lums = [];
      for (let i = 0; i < d.data.length; i += 4)
        lums.push(0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2]);
      const sorted = Float32Array.from(lums).sort();
      const lo = sorted[Math.floor(sorted.length * 0.05)], hi = sorted[Math.floor(sorted.length * 0.95)];
      const span = Math.max(1, hi - lo);
      for (let i = 0, p = 0; i < d.data.length; i += 4, p++) {
        const v = Math.max(0, Math.min(255, ((lums[p] - lo) / span) * 255));
        d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
      }
      uctx.putImageData(d, 0, 0);
      processed = measurePair(up, 4);
    }
    return { raw, processed, rawCapH };
  }, { b64, mime, prefixBox, bodyBox });
}

const results = [];
for (const c of cases) {
  let file, mime;
  if (c.kind === 'matrix') {
    const page = await browser.newPage({ deviceScaleFactor: c.cfg.scale, viewport: { width: 800, height: 960 } });
    await page.setContent(labelHtml(c.cfg));
    file = path.join(OUT, `${c.name}.${c.cfg.jpeg ? 'jpg' : 'png'}`);
    await page.locator('#label').screenshot({ path: file, type: c.cfg.jpeg ? 'jpeg' : 'png', ...(c.cfg.jpeg ? { quality: 70 } : {}) });
    await page.close();
    mime = c.cfg.jpeg ? 'jpeg' : 'png';
  } else {
    file = c.file;
    mime = /\.jpe?g$/i.test(file) ? 'jpeg' : 'png';
  }

  const { data } = await worker.recognize(file, {}, { blocks: true });
  const words = [];
  for (const b of data.blocks ?? [])
    for (const p of b.paragraphs)
      for (const l of p.lines)
        for (const w of l.words) words.push({ text: w.text.toUpperCase(), ...w.bbox });
  const clean = (t) => t.replace(/[^A-Z0-9]/g, '');
  const prefix = words.find((w) => clean(w.text).startsWith('GOVERNMENT'));
  const body = words.find((w) => clean(w.text).startsWith('ACCORDING')) ??
               words.find((w) => clean(w.text).startsWith('CONSUMPTION')) ??
               words.find((w) => clean(w.text).startsWith('BEVERAGES'));

  const b64 = fs.readFileSync(file).toString('base64');
  const ai = await aiJudgment(b64, mime);

  if (!prefix || !body) {
    results.push({ name: c.name, group: c.group, truthBold: c.truthBold, note: c.note, ai, measurable: false });
    console.log(`${c.name} [${c.group}]: OCR-UNMEASURABLE ai=${ai}`);
    continue;
  }

  const sig = await pixelSignals(file, mime, prefix, body);
  const pick = sig?.processed ?? sig?.raw ?? null;
  if (!pick) {
    results.push({ name: c.name, group: c.group, truthBold: c.truthBold, note: c.note, ai, measurable: false });
    console.log(`${c.name} [${c.group}]: PIXEL-UNMEASURABLE ai=${ai}`);
    continue;
  }
  const r = {
    name: c.name, group: c.group, truthBold: c.truthBold, note: c.note, ai, measurable: true,
    preprocessed: !!sig.processed, rawCapH: sig.rawCapH,
    swRatio: Math.round((pick.pref.nsw / pick.body.nsw) * 1000) / 1000,
    densRatio: Math.round((pick.pref.inkFrac / pick.body.inkFrac) * 1000) / 1000,
    sizeRatio: Math.round((pick.pref.capH / pick.body.capH) * 1000) / 1000,
    nswPrefix: Math.round(pick.pref.nsw * 1000) / 1000,
    nswBody: Math.round(pick.body.nsw * 1000) / 1000,
  };
  results.push(r);
  console.log(`${c.name} [${c.group}]: sw=${r.swRatio} dens=${r.densRatio} size=${r.sizeRatio} ai=${ai}${r.preprocessed ? ' (preproc)' : ''} truth=${c.truthBold ? 'BOLD' : 'not'}`);
}
await worker.terminate();
await browser.close();

// ---- gate search: zero confident mistakes, maximize coverage ----
// Scored = everything except the definitional cases (semibold, all-bold).
const scored = results.filter((r) => !['semibold-600', 'all-bold'].includes(r.group));
const gate = (r, T) => {
  if (!r.measurable) return r.ai === 'unclear' ? 'human' : 'human'; // OCR failed → always human
  if (r.swRatio >= T.swHi && r.densRatio >= T.dHi && r.ai === 'bold') return 'bold';
  if (r.swRatio <= T.swLo && r.ai === 'not_bold') return 'not_bold';
  return 'human';
};
let best = null;
for (let swHi = 1.05; swHi <= 1.6; swHi += 0.025) {
  for (let swLo = 0.9; swLo <= Math.min(swHi, 1.25); swLo += 0.025) {
    for (let dHi = 1.0; dHi <= 1.6; dHi += 0.05) {
      const T = { swHi: +swHi.toFixed(3), swLo: +swLo.toFixed(3), dHi: +dHi.toFixed(3) };
      let wrong = 0, auto = 0;
      for (const r of scored) {
        const g = gate(r, T);
        if (g === 'human') continue;
        auto++;
        if ((g === 'bold') !== r.truthBold) wrong++;
      }
      if (wrong === 0 && (!best || auto > best.auto)) best = { ...T, auto };
    }
  }
}

console.log('\n=== Gate search (zero confident mistakes required) ===');
if (!best) {
  console.log('NO thresholds achieve zero confident mistakes with nonzero coverage.');
} else {
  console.log(`best: swHi=${best.swHi} swLo=${best.swLo} dHi=${best.dHi} → auto-resolves ${best.auto}/${scored.length} scored cases (${Math.round((best.auto / scored.length) * 100)}% coverage), 0 confident mistakes`);
  for (const g of [...new Set(scored.map((r) => r.group))]) {
    const rows = scored.filter((r) => r.group === g);
    const auto = rows.filter((r) => gate(r, best) !== 'human').length;
    console.log(`  ${g}: ${auto}/${rows.length} auto-resolved`);
  }
  // Definitional cases under the chosen gate (informational)
  for (const g of ['semibold-600', 'all-bold']) {
    const rows = results.filter((r) => r.group === g);
    console.log(`  [info] ${g}: ${rows.map((r) => `${r.name}→${gate(r, best)}`).join(', ')}`);
  }
}

// AI-alone baseline for comparison
const aiRight = scored.filter((r) => (r.ai === 'bold') === r.truthBold && r.ai !== 'unclear').length;
const aiWrong = scored.filter((r) => r.ai !== 'unclear' && (r.ai === 'bold') !== r.truthBold).length;
console.log(`\nAI signal alone on scored set: ${aiRight} right, ${aiWrong} wrong, ${scored.length - aiRight - aiWrong} unclear`);

fs.writeFileSync(path.join(OUT, 'multisignal-results.json'), JSON.stringify({ results, gate: best }, null, 2));
console.log(`\nRaw results in ${OUT}/multisignal-results.json`);
