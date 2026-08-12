// Bold-densitometry validation matrix: does the ink-fraction ratio survive
// font, type-size, resolution, JPEG-q70 (COLA standard), background, and the
// regulatory boundary cases (semibold prefix; all-bold warning, which
// violates 27 CFR 16.22(a)(2) "remainder may not appear in bold")?
// Renders synthetic labels axis-by-axis off a base config and measures each
// with the same metric as bold-densitometry-spike.mjs (frozen threshold 1.53).
// Run from samples/tools: node bold-densitometry-matrix.mjs <outDir>
import { chromium } from 'playwright';
import { createWorker } from 'tesseract.js';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] ?? path.join(process.cwd(), 'matrix-out');
fs.mkdirSync(OUT, { recursive: true });

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

// Base config; each case overrides one axis. truthBold: is the PREFIX bold?
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
  cases.push({ name, group, cfg: { ...BASE, ...over }, truthBold, note });

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
add('allbold-georgia', 'all-bold', { bodyWeight: 700 }, true, 'VIOLATION: body bold (16.22(a)(2))');
add('allbold-arial', 'all-bold', { font: 'Arial,Helvetica,sans-serif', bodyWeight: 700 }, true, 'VIOLATION: body bold');
// COLA-typical: JPEG q70 at 0.75x — the realistic submission per TTB guidance
for (const [fname, font] of FONTS) {
  add(`cola-${fname}-bold`, 'cola-typical', { font, jpeg: true, scale: 0.75 }, true);
  add(`cola-${fname}-reg`, 'cola-typical', { font, jpeg: true, scale: 0.75, prefixWeight: 400 }, false);
}

console.log(`${cases.length} cases`);
const browser = await chromium.launch();
const worker = await createWorker('eng');
const measurePage = await browser.newPage();

const results = [];
for (const c of cases) {
  const page = await browser.newPage({ deviceScaleFactor: c.cfg.scale, viewport: { width: 800, height: 960 } });
  await page.setContent(labelHtml(c.cfg));
  const el = page.locator('#label');
  const file = path.join(OUT, `${c.name}.${c.cfg.jpeg ? 'jpg' : 'png'}`);
  await el.screenshot({ path: file, type: c.cfg.jpeg ? 'jpeg' : 'png', ...(c.cfg.jpeg ? { quality: 70 } : {}) });
  await page.close();

  const { data } = await worker.recognize(file, {}, { blocks: true });
  const words = [];
  for (const b of data.blocks ?? [])
    for (const p of b.paragraphs)
      for (const l of p.lines)
        for (const w of l.words) words.push({ text: w.text.toUpperCase(), ...w.bbox });
  // OCR glues stray punctuation onto words ("‘GOVERNMENT", "(GOVERNMENT") —
  // match on the alphanumeric core, not the raw token.
  const clean = (t) => t.replace(/[^A-Z0-9]/g, '');
  const prefix = words.find((w) => clean(w.text).startsWith('GOVERNMENT'));
  const body = words.find((w) => clean(w.text).startsWith('ACCORDING')) ??
               words.find((w) => clean(w.text).startsWith('CONSUMPTION')) ??
               words.find((w) => clean(w.text).startsWith('BEVERAGES'));
  if (!prefix || !body) {
    results.push({ ...c, cfg: undefined, outcome: 'unmeasurable' });
    console.log(`${c.name} [${c.group}]: UNMEASURABLE`);
    continue;
  }

  const b64 = fs.readFileSync(file).toString('base64');
  const mime = c.cfg.jpeg ? 'jpeg' : 'png';
  const m = await measurePage.evaluate(async ({ b64, mime, boxes }) => {
    const img = new Image();
    img.src = `data:image/${mime};base64,` + b64;
    await new Promise((r) => (img.onload = r));
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const lumOf = (box) => {
      const w = box.x1 - box.x0, h = box.y1 - box.y0;
      if (w <= 0 || h <= 0) return null;
      const d = ctx.getImageData(box.x0, box.y0, w, h).data;
      const rows = [];
      for (let y = 0; y < h; y++) {
        const row = [];
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          row.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
        }
        rows.push(row);
      }
      return rows;
    };
    const bodyRows = lumOf(boxes.body), prefixRows = lumOf(boxes.prefix);
    if (!bodyRows || !prefixRows) return null;
    const hist = new Array(10).fill(0);
    for (const row of bodyRows) for (const v of row) hist[Math.min(9, Math.floor(v / 25.6))]++;
    const bg = hist.indexOf(Math.max(...hist)) * 25.6 + 12.8;
    const ink = (rows) => {
      const per = rows.map((row) => row.filter((v) => Math.abs(v - bg) > 60).length);
      const act = rows.map((_, y) => y).filter((y) => per[y] > rows[y].length * 0.02);
      if (!act.length) return null;
      let i = 0, t = 0;
      for (const y of act) { i += per[y]; t += rows[y].length; }
      return i / t;
    };
    return { prefix: ink(prefixRows), body: ink(bodyRows) };
  }, { b64, mime, boxes: { prefix, body } });

  if (!m || !m.prefix || !m.body) {
    results.push({ ...c, cfg: undefined, outcome: 'unmeasurable' });
    console.log(`${c.name} [${c.group}]: UNMEASURABLE (empty box)`);
    continue;
  }
  const ratio = m.prefix / m.body;
  const call = ratio > 1.53;
  const ok = call === c.truthBold;
  results.push({ name: c.name, group: c.group, truthBold: c.truthBold, note: c.note, ratio: Math.round(ratio * 100) / 100, call: call ? 'bold' : 'not-bold', ok });
  console.log(`${c.name} [${c.group}]: ratio=${ratio.toFixed(2)} → ${call ? 'BOLD' : 'not-bold'} truth=${c.truthBold ? 'BOLD' : 'not-bold'} ${ok ? 'OK' : 'WRONG'}${c.note ? '  (' + c.note + ')' : ''}`);
}
await worker.terminate();
await browser.close();

// Per-group summary (semibold/all-bold reported, not scored — definitional cases)
const scoredGroups = ['fonts', 'type-size', 'resolution', 'jpeg', 'dark-bg', 'cola-typical'];
console.log('\n=== Summary (frozen threshold 1.53) ===');
for (const g of [...scoredGroups, 'semibold-600', 'all-bold']) {
  const rows = results.filter((r) => r.group === g);
  const un = rows.filter((r) => r.outcome === 'unmeasurable').length;
  const scored = rows.filter((r) => r.ratio !== undefined);
  const right = scored.filter((r) => r.ok).length;
  console.log(`${g}: ${right}/${scored.length} correct, ${un} unmeasurable${g === 'semibold-600' || g === 'all-bold' ? ' [informational]' : ''}`);
}
fs.writeFileSync(path.join(OUT, 'matrix-results.json'), JSON.stringify(results, null, 2));
console.log(`\nResults + images in ${OUT}`);
