// Multi-signal bold gate — ROUND 2 of the bounded loop.
// Round-1 diagnosis: (a) whole-label OCR word-finding caused most
// "unmeasurable" routes; (b) normalizing stroke width by OCR-derived cap
// height injected box noise that cancelled the real signal.
// Round-2 fixes:
//   - generated cases carry EXACT prefix/body boxes from the DOM (no OCR)
//   - real labels: crop the warning region (ground-truth sidecar box),
//     3x upscale + contrast stretch, then OCR the crop only
//   - stroke feature is the RAW stroke-width ratio prefix/body (same nominal
//     size on a label); size ratio becomes a sanity gate, not a divisor
//   - train/validation split: thresholds tuned on the original matrix+labels,
//     scored on 24 never-seen fonts + the degraded set
// Run from samples/tools:  node bold-multisignal-r2.mjs <outDir>
import { chromium } from 'playwright';
import { createWorker } from 'tesseract.js';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] ?? path.join(process.cwd(), 'multisignal-r2-out');
fs.mkdirSync(OUT, { recursive: true });
const ROOT = path.resolve(process.cwd(), '..', '..');

function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const env = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  const m = env.match(/ANTHROPIC_API_KEY\s*=\s*"?([^"\r\n]+)/);
  if (!m) throw new Error('no ANTHROPIC_API_KEY');
  return m[1].trim();
}
const KEY = apiKey();

// Reuse round-1 AI judgments by case name (same deterministic images) to
// avoid re-spending ~80 calls; only new cases get fresh calls.
const r1Path = path.join(process.cwd(), 'multisignal-out', 'multisignal-results.json');
const aiCache = new Map();
if (fs.existsSync(r1Path)) {
  for (const r of JSON.parse(fs.readFileSync(r1Path, 'utf8')).results) {
    if (r.ai) aiCache.set(r.name, r.ai);
  }
}

const PREFIX = 'GOVERNMENT WARNING:';
const BODY_REF = '(1) According to the Surgeon General,';
const BODY_REST =
  ' women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.';

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
    <div class="warning"><span id="pfx" style="font-weight:${prefixWeight};">${PREFIX}</span> <span id="bodyref">${BODY_REF}</span>${BODY_REST}</div>
  </div></body></html>`;
}

const BASE = { font: "Georgia,'Times New Roman',serif", warnPx: 13, prefixWeight: 700, bodyWeight: 400, dark: false, scale: 1, jpeg: false };
const TRAIN_FONTS = [
  ['georgia', "Georgia,'Times New Roman',serif"],
  ['arial', 'Arial,Helvetica,sans-serif'],
  ['arial-narrow', "'Arial Narrow',Arial,sans-serif"],
  ['times', "'Times New Roman',serif"],
  ['courier', "'Courier New',monospace"],
  ['verdana', 'Verdana,sans-serif'],
];
// Never seen by the threshold search — the validation fonts.
const VAL_FONTS = [
  ['palatino', "'Palatino Linotype','Book Antiqua',serif"],
  ['cambria', 'Cambria,serif'],
  ['calibri', 'Calibri,sans-serif'],
  ['tahoma', 'Tahoma,sans-serif'],
  ['trebuchet', "'Trebuchet MS',sans-serif"],
  ['garamond', 'Garamond,serif'],
];

const cases = [];
const add = (name, group, split, over, truthBold, note = '') =>
  cases.push({ kind: 'gen', name, group, split, cfg: { ...BASE, ...over }, truthBold, note });

for (const [fname, font] of TRAIN_FONTS) {
  add(`font-${fname}-bold`, 'fonts', 'train', { font }, true);
  add(`font-${fname}-reg`, 'fonts', 'train', { font, prefixWeight: 400 }, false);
}
for (const px of [10, 13, 18]) {
  add(`size-${px}px-bold`, 'type-size', 'train', { warnPx: px }, true);
  add(`size-${px}px-reg`, 'type-size', 'train', { warnPx: px, prefixWeight: 400 }, false);
}
for (const scale of [0.5, 1, 2]) {
  add(`res-${scale}x-bold`, 'resolution', 'train', { scale }, true);
  add(`res-${scale}x-reg`, 'resolution', 'train', { scale, prefixWeight: 400 }, false);
}
add('jpeg-q70-bold', 'jpeg', 'train', { jpeg: true }, true);
add('jpeg-q70-reg', 'jpeg', 'train', { jpeg: true, prefixWeight: 400 }, false);
add('dark-bg-bold', 'dark-bg', 'train', { dark: true }, true);
add('dark-bg-reg', 'dark-bg', 'train', { dark: true, prefixWeight: 400 }, false);
for (const [fname, font] of TRAIN_FONTS) {
  add(`semibold-${fname}`, 'semibold-600', 'info', { font, prefixWeight: 600 }, true, 'boundary');
}
add('allbold-georgia', 'all-bold', 'info', { bodyWeight: 700 }, true, 'VIOLATION: body bold');
add('allbold-arial', 'all-bold', 'info', { font: 'Arial,Helvetica,sans-serif', bodyWeight: 700 }, true, 'VIOLATION: body bold');
for (const [fname, font] of TRAIN_FONTS) {
  add(`cola-${fname}-bold`, 'cola-typical', 'train', { font, jpeg: true, scale: 0.75 }, true);
  add(`cola-${fname}-reg`, 'cola-typical', 'train', { font, jpeg: true, scale: 0.75, prefixWeight: 400 }, false);
}
// Validation: unseen fonts, clean + COLA-typical quality.
for (const [fname, font] of VAL_FONTS) {
  add(`val-${fname}-bold`, 'val-clean', 'val', { font }, true);
  add(`val-${fname}-reg`, 'val-clean', 'val', { font, prefixWeight: 400 }, false);
  add(`val-cola-${fname}-bold`, 'val-cola', 'val', { font, jpeg: true, scale: 0.75 }, true);
  add(`val-cola-${fname}-reg`, 'val-cola', 'val', { font, jpeg: true, scale: 0.75, prefixWeight: 400 }, false);
}

// Real labels (train) + degraded (validation).
const labelsDir = path.join(ROOT, 'samples', 'labels');
const degradedDir = path.join(ROOT, 'samples', 'degraded');
const warningBoxOf = (base) => {
  const p = path.join(labelsDir, `${base}.boxes.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')).warning ?? null;
};
for (const f of fs.readdirSync(labelsDir).filter((f) => f.endsWith('.png'))) {
  const base = f.replace(/\.png$/, '');
  const sidecar = JSON.parse(fs.readFileSync(path.join(labelsDir, `${base}.json`), 'utf8'));
  if (typeof sidecar.warning_prefix_bold !== 'boolean') continue;
  const wbox = warningBoxOf(base);
  if (!wbox) continue;
  cases.push({ kind: 'file', name: `label-${base}`, group: 'sample-labels', split: 'train', file: path.join(labelsDir, f), wbox, truthBold: sidecar.warning_prefix_bold });
}
if (fs.existsSync(degradedDir)) {
  for (const f of fs.readdirSync(degradedDir).filter((f) => /\.(png|jpg|jpeg)$/i.test(f))) {
    const m = f.match(/^(.*)--(blur|tilt|glare)\.\w+$/);
    if (!m) continue;
    const [, base, kind] = m;
    const sidecarPath = path.join(labelsDir, `${base}.json`);
    if (!fs.existsSync(sidecarPath)) continue;
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    if (typeof sidecar.warning_prefix_bold !== 'boolean') continue;
    const wbox = warningBoxOf(base);
    if (!wbox) continue;
    // Tilt shifts geometry — pad the crop generously and let OCR decide.
    cases.push({ kind: 'file', name: `degraded-${base}--${kind}`, group: 'degraded', split: 'val', file: path.join(degradedDir, f), wbox, pad: kind === 'tilt' ? 0.10 : 0.03, truthBold: sidecar.warning_prefix_bold });
  }
}
console.log(`${cases.length} cases (${cases.filter((c) => c.split === 'train').length} train / ${cases.filter((c) => c.split === 'val').length} val / ${cases.filter((c) => c.split === 'info').length} info)`);

async function aiJudgment(name, b64, mime) {
  if (aiCache.has(name)) return aiCache.get(name);
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

const browser = await chromium.launch();
const worker = await createWorker('eng');
const measurePage = await browser.newPage();

// Shared in-page measurement: given a data-URI image and two pixel boxes on
// it, compute raw stroke width (median min-run), ink fraction, cap height.
const MEASURE_FN = `
  globalThis.lumRows = (ctx, x0, y0, w, h) => {
    const d = ctx.getImageData(x0, y0, w, h).data;
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
  globalThis.modalBg = (rows) => {
    const hist = new Array(10).fill(0);
    for (const row of rows) for (const v of row) hist[Math.min(9, Math.floor(v / 25.6))]++;
    return hist.indexOf(Math.max(...hist)) * 25.6 + 12.8;
  };
  globalThis.measure = (rows, bg) => {
    if (!rows || !rows.length) return null;
    const h = rows.length, w = rows[0].length;
    const ink = rows.map((row) => Array.from(row, (v) => Math.abs(v - bg) > 55));
    const perRow = ink.map((r) => r.reduce((a, b) => a + (b ? 1 : 0), 0));
    const act = perRow.map((n, y) => (n > w * 0.02 ? y : -1)).filter((y) => y >= 0);
    if (act.length < 2) return null;
    const capH = act[act.length - 1] - act[0] + 1;
    let inkPx = 0, totPx = 0;
    for (const y of act) { inkPx += perRow[y]; totPx += w; }
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
    if (widths.length < 20) return null;
    widths.sort((a, b) => a - b);
    return { capH, inkFrac: inkPx / totPx, sw: widths[Math.floor(widths.length / 2)] };
  };
`;

// Generated case: exact DOM boxes → measure directly (with the same upscale
// pre-processing when the prefix is small).
async function measureGen(file, mime, boxes) {
  const b64 = fs.readFileSync(file).toString('base64');
  return await measurePage.evaluate(async ({ b64, mime, boxes, MEASURE_FN }) => {
    eval(MEASURE_FN);
    const img = new Image();
    img.src = `data:image/${mime};base64,` + b64;
    await new Promise((r) => (img.onload = r));
    const draw = (scale) => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth * scale; c.height = img.naturalHeight * scale;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return ctx;
    };
    const pair = (scale) => {
      const ctx = draw(scale);
      const crop = (b) => {
        const x0 = Math.max(0, Math.round((b.x - 2) * scale)), y0 = Math.max(0, Math.round((b.y - 2) * scale));
        const w = Math.round((b.w + 4) * scale), h = Math.round((b.h + 4) * scale);
        return lumRows(ctx, x0, y0, Math.min(w, ctx.canvas.width - x0), Math.min(h, ctx.canvas.height - y0));
      };
      const bodyR = crop(boxes.body), prefR = crop(boxes.prefix);
      if (!bodyR || !prefR) return null;
      const bg = modalBg(bodyR);
      const body = measure(bodyR, bg), pref = measure(prefR, bg);
      return body && pref ? { pref, body } : null;
    };
    let m = pair(1);
    let preprocessed = false;
    if (m && m.pref.capH < 12) { const up = pair(3); if (up) { m = up; preprocessed = true; } }
    if (!m) { const up = pair(3); if (up) { m = up; preprocessed = true; } }
    return m ? { ...m, preprocessed } : null;
  }, { b64, mime, boxes, MEASURE_FN });
}

// File case: crop warning region (fractional sidecar box), 3x upscale +
// contrast stretch, OCR the crop for word boxes, then measure on the crop.
async function measureFile(file, mime, wbox, pad = 0.03) {
  const b64 = fs.readFileSync(file).toString('base64');
  const prep = await measurePage.evaluate(async ({ b64, mime, wbox, pad }) => {
    const img = new Image();
    img.src = `data:image/${mime};base64,` + b64;
    await new Promise((r) => (img.onload = r));
    const W = img.naturalWidth, H = img.naturalHeight;
    const x0 = Math.max(0, Math.round((wbox.left - pad) * W));
    const y0 = Math.max(0, Math.round((wbox.top - pad) * H));
    const w = Math.min(W - x0, Math.round((wbox.width + 2 * pad) * W));
    const h = Math.min(H - y0, Math.round((wbox.height + 2 * pad) * H));
    if (w < 8 || h < 4) return null;
    const S = 3;
    const c = document.createElement('canvas');
    c.width = w * S; c.height = h * S;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, x0, y0, w, h, 0, 0, c.width, c.height);
    // contrast stretch
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
  }, { b64, mime, wbox, pad });
  if (!prep) return null;

  const cropFile = path.join(OUT, `_crop.png`);
  fs.writeFileSync(cropFile, Buffer.from(prep, 'base64'));
  const { data } = await worker.recognize(cropFile, {}, { blocks: true });
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
  if (!prefix || !body) return null;

  return await measurePage.evaluate(async ({ b64, prefix, body, MEASURE_FN }) => {
    eval(MEASURE_FN);
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await new Promise((r) => (img.onload = r));
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const crop = (b) => {
      const x0 = Math.max(0, b.x0 - 2), y0 = Math.max(0, b.y0 - 2);
      return lumRows(ctx, x0, y0, Math.min(b.x1 - b.x0 + 4, c.width - x0), Math.min(b.y1 - b.y0 + 4, c.height - y0));
    };
    const bodyR = crop(body), prefR = crop(prefix);
    if (!bodyR || !prefR) return null;
    const bg = modalBg(bodyR);
    const bm = measure(bodyR, bg), pm = measure(prefR, bg);
    return bm && pm ? { pref: pm, body: bm, preprocessed: true } : null;
  }, { b64: prep, prefix, body, MEASURE_FN });
}

const results = [];
for (const c of cases) {
  let file, mime, m = null;
  if (c.kind === 'gen') {
    const page = await browser.newPage({ deviceScaleFactor: c.cfg.scale, viewport: { width: 800, height: 960 } });
    await page.setContent(labelHtml(c.cfg));
    const boxes = await page.evaluate(() => {
      const label = document.querySelector('#label').getBoundingClientRect();
      const r = (el) => {
        const b = el.getBoundingClientRect();
        return { x: b.x - label.x, y: b.y - label.y, w: b.width, h: b.height };
      };
      return { prefix: r(document.querySelector('#pfx')), body: r(document.querySelector('#bodyref')) };
    });
    file = path.join(OUT, `${c.name}.${c.cfg.jpeg ? 'jpg' : 'png'}`);
    await page.locator('#label').screenshot({ path: file, type: c.cfg.jpeg ? 'jpeg' : 'png', ...(c.cfg.jpeg ? { quality: 70 } : {}) });
    await page.close();
    mime = c.cfg.jpeg ? 'jpeg' : 'png';
    const s = c.cfg.scale;
    m = await measureGen(file, mime, {
      prefix: { x: boxes.prefix.x * s, y: boxes.prefix.y * s, w: boxes.prefix.w * s, h: boxes.prefix.h * s },
      body: { x: boxes.body.x * s, y: boxes.body.y * s, w: boxes.body.w * s, h: boxes.body.h * s },
    });
  } else {
    file = c.file;
    mime = /\.jpe?g$/i.test(file) ? 'jpeg' : 'png';
    m = await measureFile(file, mime, c.wbox, c.pad ?? 0.03);
  }

  const ai = await aiJudgment(c.name, fs.readFileSync(file).toString('base64'), mime);

  if (!m) {
    results.push({ name: c.name, group: c.group, split: c.split, truthBold: c.truthBold, note: c.note, ai, measurable: false });
    console.log(`${c.name} [${c.group}/${c.split}]: UNMEASURABLE ai=${ai}`);
    continue;
  }
  const r = {
    name: c.name, group: c.group, split: c.split, truthBold: c.truthBold, note: c.note, ai, measurable: true,
    preprocessed: !!m.preprocessed,
    swRatio: Math.round((m.pref.sw / m.body.sw) * 1000) / 1000,
    densRatio: Math.round((m.pref.inkFrac / m.body.inkFrac) * 1000) / 1000,
    sizeRatio: Math.round((m.pref.capH / m.body.capH) * 1000) / 1000,
    swPrefix: m.pref.sw, swBody: m.body.sw, capHPrefix: m.pref.capH,
  };
  results.push(r);
  console.log(`${c.name} [${c.group}/${c.split}]: sw=${r.swRatio} dens=${r.densRatio} size=${r.sizeRatio} ai=${ai}${r.preprocessed ? ' (pre)' : ''} truth=${c.truthBold ? 'BOLD' : 'not'}`);
}
await worker.terminate();
await browser.close();

// ---- gate: tune on train only, then score validation untouched ----
const SIZE_OK = (r) => r.sizeRatio >= 0.6 && r.sizeRatio <= 1.7;
const gate = (r, T) => {
  if (!r.measurable || !SIZE_OK(r)) return 'human';
  if (r.swRatio >= T.swHi && r.densRatio >= T.dHi && r.ai === 'bold') return 'bold';
  if (r.swRatio <= T.swLo && r.densRatio <= T.dLo) return 'not_bold';
  return 'human';
};
const train = results.filter((r) => r.split === 'train');
const val = results.filter((r) => r.split === 'val');

let best = null;
for (let swHi = 1.1; swHi <= 1.7; swHi += 0.025) {
  for (let swLo = 0.85; swLo <= 1.2; swLo += 0.025) {
    if (swLo >= swHi) continue;
    for (let dHi = 1.0; dHi <= 1.6; dHi += 0.05) {
      for (let dLo = 0.9; dLo <= 1.35; dLo += 0.05) {
        const T = { swHi: +swHi.toFixed(3), swLo: +swLo.toFixed(3), dHi: +dHi.toFixed(3), dLo: +dLo.toFixed(3) };
        let wrong = 0, auto = 0;
        for (const r of train) {
          const g = gate(r, T);
          if (g === 'human') continue;
          auto++;
          if ((g === 'bold') !== r.truthBold) { wrong = 1; break; }
        }
        if (!wrong && (!best || auto > best.auto)) best = { ...T, auto };
      }
    }
  }
}

console.log('\n=== ROUND 2 ===');
if (!best) {
  console.log('TRAIN: no zero-mistake thresholds found.');
} else {
  console.log(`TRAIN tuned: swHi=${best.swHi} swLo=${best.swLo} dHi=${best.dHi} dLo=${best.dLo} → ${best.auto}/${train.length} auto (${Math.round((best.auto / train.length) * 100)}%), 0 mistakes`);
  let vAuto = 0, vWrong = [];
  for (const r of val) {
    const g = gate(r, best);
    if (g === 'human') continue;
    vAuto++;
    if ((g === 'bold') !== r.truthBold) vWrong.push(`${r.name}: gate=${g} truth=${r.truthBold ? 'bold' : 'not'}`);
  }
  console.log(`VALIDATION (never seen): ${vAuto}/${val.length} auto (${Math.round((vAuto / val.length) * 100)}%), ${vWrong.length} confident mistakes${vWrong.length ? ' — ' + vWrong.join('; ') : ''}`);
  for (const g of [...new Set(results.map((r) => r.group))]) {
    const rows = results.filter((r) => r.group === g && r.split !== 'info');
    if (!rows.length) continue;
    const auto = rows.filter((r) => gate(r, best) !== 'human').length;
    const wrong = rows.filter((r) => { const x = gate(r, best); return x !== 'human' && (x === 'bold') !== r.truthBold; }).length;
    console.log(`  ${g} [${rows[0].split}]: ${auto}/${rows.length} auto${wrong ? `, ${wrong} WRONG` : ''}`);
  }
  for (const g of ['semibold-600', 'all-bold']) {
    const rows = results.filter((r) => r.group === g);
    console.log(`  [info] ${g}: ${rows.map((r) => `${r.name.replace(/^(semibold|allbold)-/, '')}→${gate(r, best)}`).join(', ')}`);
  }
}
fs.writeFileSync(path.join(OUT, 'multisignal-r2-results.json'), JSON.stringify({ results, gate: best }, null, 2));
console.log(`\nRaw results in ${OUT}/multisignal-r2-results.json`);
