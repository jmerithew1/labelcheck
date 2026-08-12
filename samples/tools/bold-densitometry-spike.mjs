// Bold densitometry spike: can PIXELS verify bold deterministically?
// Metric: ink-fraction of the warning PREFIX word box vs a BODY word box at
// the same font size — bold glyphs carry more ink per area. Validated
// against generator ground truth (warning_prefix_bold in sidecars).
// Run from samples/tools: node bold-densitometry-spike.mjs
import { chromium } from 'playwright';
import { createWorker } from 'tesseract.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABELS = path.join(here, '..', 'labels');

const files = fs.readdirSync(LABELS).filter((f) => f.endsWith('.json') && !f.endsWith('.boxes.json'));
const cases = [];
for (const f of files) {
  const sc = JSON.parse(fs.readFileSync(path.join(LABELS, f), 'utf8'));
  if (sc.warning_text_verbatim && typeof sc.warning_prefix_bold === 'boolean') {
    cases.push({ name: f.replace('.json', ''), bold: sc.warning_prefix_bold });
  }
}

const worker = await createWorker('eng');
const browser = await chromium.launch();
const page = await browser.newPage();

const results = [];
for (const c of cases) {
  const png = path.join(LABELS, `${c.name}.png`);
  const { data } = await worker.recognize(png, {}, { blocks: true });
  const words = [];
  for (const b of data.blocks ?? [])
    for (const p of b.paragraphs)
      for (const l of p.lines)
        for (const w of l.words) words.push({ text: w.text.toUpperCase(), ...w.bbox });
  const prefix = words.find((w) => w.text.startsWith('GOVERNMENT'));
  // Body reference: a non-bold word from the same warning block, same size.
  const body = words.find((w) => w.text.startsWith('ACCORDING')) ??
               words.find((w) => w.text.startsWith('CONSUMPTION')) ??
               words.find((w) => w.text.startsWith('BEVERAGES'));
  if (!prefix || !body) { results.push({ ...c, skip: 'words not found' }); continue; }

  const b64 = fs.readFileSync(png).toString('base64');
  const metrics = await page.evaluate(async ({ b64, boxes }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await new Promise((r) => (img.onload = r));
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
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
    // Shared background from the SPARSE body box (its modal luminance is
    // reliably the page, not the ink — dense bold boxes invert that).
    const bodyRows = lumOf(boxes.body);
    const prefixRows = lumOf(boxes.prefix);
    if (!bodyRows || !prefixRows) return { prefix: null, body: null };
    const hist = new Array(10).fill(0);
    for (const row of bodyRows) for (const v of row) hist[Math.min(9, Math.floor(v / 25.6))]++;
    const bg = hist.indexOf(Math.max(...hist)) * 25.6 + 12.8;
    const inkFraction = (rows) => {
      // Crop to rows that actually contain ink — OCR box heights vary with
      // ascenders/leading and dilute the coverage measurement.
      const inkPerRow = rows.map((row) => row.filter((v) => Math.abs(v - bg) > 60).length);
      const active = rows.map((_, y) => y).filter((y) => inkPerRow[y] > rows[y].length * 0.02);
      if (!active.length) return null;
      let ink = 0, total = 0;
      for (const y of active) { ink += inkPerRow[y]; total += rows[y].length; }
      return ink / total;
    };
    return { prefix: inkFraction(prefixRows), body: inkFraction(bodyRows) };
  }, { b64, boxes: { prefix, body } });

  if (!metrics.prefix || !metrics.body) { results.push({ ...c, skip: 'empty box' }); continue; }
  const ratio = metrics.prefix / metrics.body;
  results.push({ ...c, ratio: Math.round(ratio * 100) / 100, prefixInk: Math.round(metrics.prefix * 1000) / 1000, bodyInk: Math.round(metrics.body * 1000) / 1000 });
  console.log(`${c.name}: ratio=${ratio.toFixed(2)} (prefix ${metrics.prefix.toFixed(3)} / body ${metrics.body.toFixed(3)}) truth=${c.bold ? 'BOLD' : 'not-bold'}`);
}
await worker.terminate();
await browser.close();

// Find the best single threshold.
const scored = results.filter((r) => r.ratio !== undefined);
let best = { t: 0, acc: 0 };
for (let t = 1.0; t <= 2.0; t += 0.01) {
  const acc = scored.filter((r) => (r.ratio > t) === r.bold).length / scored.length;
  if (acc > best.acc) best = { t: Math.round(t * 100) / 100, acc };
}
const correct = scored.filter((r) => (r.ratio > best.t) === r.bold).length;
console.log(`\nBest threshold ratio > ${best.t}: ${correct}/${scored.length} correct (${Math.round(best.acc * 1000) / 10}%)`);
console.log('Misses:', scored.filter((r) => (r.ratio > best.t) !== r.bold).map((r) => `${r.name} (ratio ${r.ratio}, truth ${r.bold ? 'bold' : 'not-bold'})`).join('; ') || 'none');
fs.writeFileSync(path.join(here, '..', '..', 'docs', 'bold-densitometry-spike.json'), JSON.stringify({ best_threshold: best.t, accuracy: best.acc, results: scored }, null, 2));
