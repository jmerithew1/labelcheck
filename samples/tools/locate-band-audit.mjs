// Out-of-sample audit: does the located warning band actually contain the
// warning, on REAL approved TTB labels — as shipped, vs with the image
// normalised to 1000px tall before the locate call?
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';

const ROOT = 'C:/dev/labelcheck';
const BASE = 'http://localhost:56907';
const REAL = path.join(ROOT, 'samples', 'real');
const N = Number(process.argv[2] ?? 14);

const man = JSON.parse(fs.readFileSync(path.join(REAL, 'manifest.json'), 'utf8'));
const rows = (Array.isArray(man) ? man : Object.values(man).find(Array.isArray))
  .filter((r) => r.has_warning !== false && /\.png$/i.test(r.file))
  .filter((r) => fs.existsSync(path.join(REAL, r.file)));

// Spread across the height range so the result isn't an artefact of one size.
const sized = rows.map((r) => {
  const b = fs.readFileSync(path.join(REAL, r.file));
  return { file: r.file, h: b.readUInt32BE(20), w: b.readUInt32BE(16) };
}).sort((a, b) => a.h - b.h);
const step = Math.max(1, Math.floor(sized.length / N));
const pick = sized.filter((_, i) => i % step === 0).slice(0, N);

const worker = await createWorker('eng');
const tmp = 'C:/Users/merit/AppData/Local/Temp/claude/_band.png';

async function locate(buf) {
  const fd = new FormData();
  fd.set('image', new Blob([buf], { type: 'image/png' }), 'x.png');
  const res = await fetch(BASE + '/api/locate', { method: 'POST', body: fd });
  return (await res.json().catch(() => null))?.bands ?? {};
}

/** Does the located band actually contain the warning prefix? */
async function bandHoldsWarning(buf, band) {
  if (!band) return false;
  const m = await sharp(buf).metadata();
  const top = Math.max(0, Math.round((band[0] / 1000) * m.height) - 6);
  const bot = Math.min(m.height, Math.round((band[1] / 1000) * m.height) + 6);
  if (bot - top < 8) return false;
  await sharp(buf).extract({ left: 0, top, width: m.width, height: bot - top })
    .resize({ width: Math.min(2000, m.width * 2) }).png().toFile(tmp);
  const { data } = await worker.recognize(tmp);
  return /GOVERNMENT\s*WARNING/i.test(data.text.replace(/\s+/g, ' '));
}

let asIs = { band: 0, hit: 0 }, fixed = { band: 0, hit: 0 };
console.log(`${pick.length} real approved TTB labels, heights ${pick[0].h}–${pick[pick.length - 1].h}px\n`);
for (const p of pick) {
  const raw = fs.readFileSync(path.join(REAL, p.file));
  const norm = await sharp(raw).resize({ height: 1000 }).png().toBuffer();

  const b1 = (await locate(raw)).warning;
  const ok1 = await bandHoldsWarning(raw, b1);
  const b2 = (await locate(norm)).warning;
  const ok2 = await bandHoldsWarning(norm, b2);

  if (b1) asIs.band++; if (ok1) asIs.hit++;
  if (b2) fixed.band++; if (ok2) fixed.hit++;
  console.log(
    `${String(p.h).padStart(4)}px  as-shipped ${(b1 ? `${b1[0]}-${b1[1]}` : 'MISSING').padEnd(11)} ${ok1 ? 'contains warning' : 'NO'}` +
    `   |  1000px-tall ${(b2 ? `${b2[0]}-${b2[1]}` : 'MISSING').padEnd(11)} ${ok2 ? 'contains warning' : 'NO'}   ${p.file.slice(0, 26)}`,
  );
}
await worker.terminate();
console.log(`\nas shipped:      band returned ${asIs.band}/${pick.length}, band actually holds the warning ${asIs.hit}/${pick.length}`);
console.log(`normalised 1000: band returned ${fixed.band}/${pick.length}, band actually holds the warning ${fixed.hit}/${pick.length}`);
