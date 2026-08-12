// Build labelled contact sheets so a human can triage many label images in a
// few looks instead of one round-trip each.
//
// Why this exists: scoring the real TTB corpus left 56 images needing human
// judgment (33 reported as "warning missing", 23 as "wording deviates"). The
// first batch taught the lesson — applicant filenames are unreliable, so
// several files named "back" turned out to be front-label artwork with no
// warning at all, making the tool's fail_missing verdict CORRECT. Only eyes
// can settle that, and eyes are the expensive resource.
//
// Each cell is numbered and the index maps number -> filename, so a verdict
// can be recorded against a specific file after reading the sheet.
//
//   node contact-sheet.mjs [--verdict=fail_missing] [--cols=6] [--cell=420]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const REAL = path.join(ROOT, 'samples', 'real');
const OUT = path.join(REAL, '_sheets');
fs.mkdirSync(OUT, { recursive: true });

const arg = (k, d) => {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${k}=`));
  return a ? a.split('=')[1] : d;
};
const WANT = arg('verdict', 'fail_missing');
const COLS = Number(arg('cols', 5));
const CELL = Number(arg('cell', 430));
const PAD = 10;
const CAP = 26; // caption strip under each cell

const scored = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'real-labels.json'), 'utf8'));
const rows = scored.results.filter((r) => r.verdict === WANT && r.outcome === 'false_rejection');
if (!rows.length) { console.log(`no rows with verdict=${WANT}`); process.exit(0); }

console.log(`${rows.length} images with verdict=${WANT} -> contact sheets`);

const perSheet = COLS * COLS;
const index = [];
let sheetNo = 0;

for (let start = 0; start < rows.length; start += perSheet) {
  const chunk = rows.slice(start, start + perSheet);
  const cols = Math.min(COLS, chunk.length);
  const sheetRows = Math.ceil(chunk.length / cols);
  const W = cols * (CELL + PAD) + PAD;
  const H = sheetRows * (CELL + CAP + PAD) + PAD;

  const composites = [];
  for (const [i, r] of chunk.entries()) {
    const n = start + i + 1;
    const col = i % cols, row = Math.floor(i / cols);
    const x = PAD + col * (CELL + PAD);
    const y = PAD + row * (CELL + CAP + PAD);
    const file = path.join(REAL, r.file);
    if (!fs.existsSync(file)) continue;
    try {
      // `contain` keeps the whole label visible — a crop could hide the very
      // warning we are trying to confirm is absent.
      const buf = await sharp(file)
        .resize(CELL, CELL, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .toBuffer();
      composites.push({ input: buf, left: x, top: y });
      const caption = Buffer.from(
        `<svg width="${CELL}" height="${CAP}" xmlns="http://www.w3.org/2000/svg">
           <rect width="${CELL}" height="${CAP}" fill="#10233f"/>
           <text x="6" y="18" font-family="monospace" font-size="15" fill="#ffffff">${n}. ${r.file.slice(0, 34)}</text>
         </svg>`,
      );
      composites.push({ input: caption, left: x, top: y + CELL });
      index.push({ n, file: r.file, ttbid: r.ttbid, verdict: r.verdict, sheet: sheetNo + 1 });
    } catch { /* unreadable image — skip, it will show as a gap */ }
  }

  sheetNo++;
  const out = path.join(OUT, `${WANT}-sheet${sheetNo}.png`);
  await sharp({ create: { width: W, height: H, channels: 3, background: { r: 232, g: 235, b: 239 } } })
    .composite(composites)
    .png()
    .toFile(out);
  console.log(`  ${path.relative(ROOT, out)}  (${chunk.length} labels)`);
}

fs.writeFileSync(path.join(OUT, `${WANT}-index.json`), JSON.stringify(index, null, 2));
console.log(`\n${sheetNo} sheet(s) + index written to ${path.relative(ROOT, OUT)}`);
