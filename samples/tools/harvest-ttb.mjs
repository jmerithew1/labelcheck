// Harvest REAL alcohol label images from the TTB Public COLA Registry.
//
// Why this exists: every base image in samples/labels/ is generator-rendered —
// our own fonts, our own layout, our own warning placement. A tool that only
// ever sees its author's renders has never been tested on the thing it claims
// to check. These are actual labels submitted to TTB by actual applicants:
// curved on the bottle, foil-stamped, photographed at angles, justified
// warning text wrapping mid-phrase.
//
// Ground truth comes free and is the point: a COLA in the registry was
// APPROVED by TTB, so its warning is compliant by definition. Any warning
// failure this tool reports on an approved back label is therefore a FALSE
// REJECTION — the costliest error class — measurable without hand-transcribing
// a single image.
//
// Source: public US government records (ttbonline.gov), no login required.
// Images are gitignored (regenerable, and not ours to redistribute); the
// scored summary and the COLA ID list are what get committed.
//
//   node harvest-ttb.mjs [--target=N] [--out=../real] [--conc=3]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${k}=`));
  return a ? a.split('=')[1] : d;
};
const OUT = path.resolve(__dirname, arg('out', '../real'));
const TARGET = Number(arg('target', 200));
fs.mkdirSync(OUT, { recursive: true });

const BASE = 'https://www.ttbonline.gov/colasonline';
const UA = 'Mozilla/5.0 (compatible; LabelCheck-research/1.0)';

// One cookie jar for the whole run: the attachment endpoint returns an HTML
// error page ("Unable to render attachment") unless the request carries the
// session established by viewing that COLA's form page first, with a matching
// Referer. That ordering is load-bearing — without it every download is HTML.
let cookie = '';
async function get(url, referer) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(referer ? { Referer: referer } : {}),
    },
    redirect: 'follow',
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  return res;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Search one completed-date; returns TTB IDs. */
async function searchDay(mmddyyyy) {
  const body = new URLSearchParams({
    'searchCriteria.dateCompletedFrom': mmddyyyy,
    'searchCriteria.dateCompletedTo': mmddyyyy,
    'searchCriteria.productNameSearchType': 'Contains',
    'searchCriteria.productOrFancifulName': '',
  });
  const res = await fetch(`${BASE}/publicSearchColasBasicProcess.do?action=search`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const html = await res.text();
  return [...new Set([...html.matchAll(/ttbid=(\d+)/g)].map((m) => m[1]))];
}

/** The form view is the only page carrying attachment filenames. */
async function attachmentsFor(ttbid) {
  const formUrl = `${BASE}/viewColaDetails.do?action=publicFormDisplay&ttbid=${ttbid}`;
  const html = await (await get(formUrl)).text();
  const files = [...html.matchAll(/publicViewAttachment\.do\?filename=([^"&]+)&filetype=(\w)/g)]
    .map((m) => ({ filename: decodeURIComponent(m[1]), filetype: m[2] }));
  const brand = (html.match(/Brand\s*Name[^]{0,400}?<td[^>]*>\s*([^<]{2,80}?)\s*</i) || [])[1]?.trim();
  const classType = (html.match(/Class\/?Type[^]{0,400}?<td[^>]*>\s*([^<]{2,80}?)\s*</i) || [])[1]?.trim();
  return { formUrl, files, brand, classType };
}

/** The warning lives on the back label — but attachment filenames are
 *  applicant-supplied and demonstrably wrong: files named "Back Label.png"
 *  have been observed containing front-label artwork. This is a cheap
 *  PREFILTER only. Whether an image really carries a warning is settled
 *  later, by eye, for exactly the cases where the tool reports it missing —
 *  never from the tool's own verdict. */
const isBack = (name) => /back|rear|wrap|reverse/i.test(name) && !/front/i.test(name);

const manifest = [];
const seen = new Set();
let downloaded = 0;

// Many small date windows rather than one wide range: the registry caps
// results per search, so this samples far more distinct applicants — and
// breadth across applicants (fonts, layouts, photography, print quality) is
// what makes this set worth more than our own renders.
const days = [];
for (const year of ['2025', '2024', '2023'])
  for (let m = 1; m <= 12; m++)
    for (const d of [4, 11, 18, 25])
      days.push(`${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${year}`);

console.log(`harvesting real TTB labels -> ${path.relative(process.cwd(), OUT)} (target ${TARGET})`);
outer:
for (const day of days) {
  if (downloaded >= TARGET) break;
  let ids = [];
  try { ids = await searchDay(day); } catch { continue; }
  if (!ids.length) continue;
  let dayCount = 0;
  for (const id of ids) {
    if (downloaded >= TARGET) break outer;
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const { formUrl, files, brand, classType } = await attachmentsFor(id);
      const backs = files.filter((f) => isBack(f.filename));
      if (!backs.length) continue;
      for (const f of backs.slice(0, 2)) {
        if (downloaded >= TARGET) break outer;
        const url = `${BASE}/publicViewAttachment.do?filename=${encodeURIComponent(f.filename)}&filetype=${f.filetype}`;
        const res = await get(url, formUrl);
        const ct = res.headers.get('content-type') || '';
        if (!/^image\//.test(ct)) continue; // the HTML error page, not an image
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 20_000) continue; // thumbnails/placeholders aren't labels
        const ext = ct.includes('png') ? 'png' : ct.includes('jpeg') ? 'jpg' : 'bin';
        const safe = f.filename.replace(/[^a-z0-9]+/gi, '-').slice(0, 24).replace(/^-|-$/g, '');
        const out = path.join(OUT, `ttb-${id}-${safe}.${ext}`);
        if (fs.existsSync(out)) continue;
        fs.writeFileSync(out, buf);
        manifest.push({
          ttbid: id,
          file: path.basename(out),
          bytes: buf.length,
          source_filename: f.filename,
          brand, class_type: classType,
          // An approved COLA is compliant by definition — that IS the label.
          approved: true,
          expect: 'no_warning_failure',
          // Left null on purpose: settled by visual inspection only for the
          // cases the tool reports missing. Never set from the tool's verdict.
          has_warning: null,
          source_url: formUrl,
        });
        downloaded++;
        dayCount++;
        if (downloaded % 10 === 0) process.stdout.write(`    ${downloaded}/${TARGET}\n`);
      }
    } catch { /* skip this COLA */ }
    await sleep(250); // be a polite guest on a government server
  }
  if (dayCount) console.log(`  ${day}: +${dayCount} (total ${downloaded})`);
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
  source: 'TTB Public COLA Registry (ttbonline.gov) — public US government records',
  harvested_labels: manifest.length,
  ground_truth:
    'Each COLA here was APPROVED by TTB, so its government warning is compliant. ' +
    'A warning failure reported on any of these is a FALSE REJECTION.',
  note_on_ground_truth:
    'Attachment filenames are applicant-supplied and unreliable — files named ' +
    '"back" have been observed containing front-label artwork, which legitimately ' +
    'has no warning. has_warning is set by direct visual inspection, only for ' +
    'images the tool reports as missing a warning, and never from the tool under test.',
  labels: manifest,
}, null, 2));

console.log(`\n${downloaded} real label images + manifest.json written`);
