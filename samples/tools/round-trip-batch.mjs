// Round-trip the batch page through its OWN front door.
//
// Why this exists: every other batch test here — the 250-label runs, the real
// TTB corpus, the out-of-sample batch — built its input inside the page with
// `new File([blob], name)` and a synthetic drop event. That construction was
// always VALID: a CSV plus its matching images, filenames aligned, in one drop.
// So those tests proved the engine handles scale, real artwork and planted
// pairing mismatches, and could not possibly catch the bug an owner hit in
// thirty seconds: download the sample CSV, drop it in on its own, and every row
// fails with "No matching label file uploaded".
//
// The download link is an app OUTPUT. The dropzone is an app INPUT. Both ends
// were verified separately and the path between them never was. This harness
// closes that loop: it takes the bytes the app actually serves, writes them to
// disk, and feeds exactly those back through the REAL file picker
// (`setInputFiles`, the same code path as a person choosing files), then reads
// the DOM for what a person would see.
//
// It also does the thing the fixed sample set cannot: pairs RANDOM labels from
// samples/labels into CSVs the repo has never shipped, using each label's
// ground-truth sidecar for the application values, and asserts the rows pair
// and come back with verdicts — with no false rejection on a label whose
// sidecar says it is clean.
//
//   node round-trip-batch.mjs [--base=http://localhost:3000] [--csvs=2]
//                             [--rows=4] [--quick] [--seed=123]
//
// --quick verifies pairing and stops before any run, so it costs zero API
// calls. Without it, every built row is actually checked.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { chromium } from 'playwright';
import { CANONICAL_WARNING } from '../../lib/compare/canonical.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const LABELS = path.join(ROOT, 'samples', 'labels');

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const a = argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split('=')[1] : d;
};
const BASE = arg('base', 'http://localhost:3000').replace(/\/$/, '');
const CSVS = Number(arg('csvs', 2));
const ROWS = Number(arg('rows', 4));
const QUICK = argv.includes('--quick');
let seed = Number(arg('seed', 20260814));

/** Deterministic RNG so a failure can be reproduced with the same --seed. */
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (arr, n) => {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  return out;
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'labelcheck-roundtrip-'));
const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Download exactly what the app serves, to disk. No re-encoding. */
async function download(urlPath, filename) {
  const res = await fetch(BASE + urlPath);
  if (!res.ok) throw new Error(`GET ${urlPath} -> HTTP ${res.status}`);
  const file = path.join(work, filename);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

const results = [];
const record = (scenario, pass, detail) => {
  results.push({ scenario, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${scenario}\n        ${detail}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

/** Drop files through the real picker and read back what the page shows. */
async function dropAndRead(files, { settleMs = 2500 } = {}) {
  await page.goto(`${BASE}/batch`, { waitUntil: 'networkidle' });
  await page.locator('input[type=file]').first().setInputFiles(files);
  await page.waitForTimeout(settleMs);
  return page.evaluate(() => {
    const main = document.querySelector('main');
    const text = main ? main.innerText : '';
    // Read the ERROR BANNER itself, not any line that happens to mention a
    // spreadsheet. The first pass at this matched the dropzone's own
    // description copy, so the assertion would have gone green on a page
    // showing no error at all — the same "instrument doesn't touch the claim"
    // mistake this harness exists to catch.
    const banner = [...document.querySelectorAll('div')]
      .find((d) => /bg-red-tint/.test(d.className || '') && /text-red/.test(d.className || '') && d.innerText.trim());
    // The table paginates at 10, so counting <tr> reports a page, not a batch.
    // The footer carries the real total.
    const totalMatch = text.match(/of (\d+) labels/);
    return {
      rowsOnPage: document.querySelectorAll('tbody tr').length,
      rows: totalMatch ? Number(totalMatch[1]) : document.querySelectorAll('tbody tr').length,
      globalError: banner ? banner.innerText.trim().slice(0, 240) : '',
      pairingIssues: (text.match(/no label file found/g) || []).length,
      orphanFiles: (text.match(/has no CSV row/g) || []).length,
      errorRows: (text.match(/No matching label file uploaded/g) || []).length,
      running: /Checking \d+ labels/.test(text),
    };
  });
}

/** Wait for a started run to finish, then summarise every row from the export. */
async function waitAndTally(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = await page.evaluate(() => /Processed on/.test(document.querySelector('main')?.innerText || ''));
    if (done) break;
    await page.waitForTimeout(2000);
  }
  return page.evaluate(async () => {
    let captured = null;
    const oc = URL.createObjectURL;
    URL.createObjectURL = (b) => { captured = b; return 'x'; };
    const ock = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    [...document.querySelectorAll('button')].find((b) => /Download report/.test(b.innerText))?.click();
    URL.createObjectURL = oc;
    HTMLAnchorElement.prototype.click = ock;
    if (!captured) return null;
    const raw = await captured.text();
    const body = raw.trim().split('\n').slice(1);
    return {
      // The exact bytes the export produced. Scenario 4 feeds these back through
      // the picker, so that round trip runs on the real export path instead of a
      // synthetic file that could silently drift from it.
      raw,
      rows: body.length,
      errors: body.filter((l) => /ERROR:/.test(l)).length,
      warningFailures: body.filter((l) => /,warning_failure,/.test(l)).length,
      clean: body.filter((l) => /,clean,/.test(l)).length,
      needsReview: body.filter((l) => /,needs_review,/.test(l)).length,
      // filename -> overall, so the caller can check a specific label's verdict
      // against its ground-truth sidecar rather than a whole-batch count.
      verdicts: Object.fromEntries(body.map((l) => {
        const c = l.split(',');
        return [c[0].replace(/^'/, ''), c[1]];
      })),
    };
  });
}

/** Raw bytes of the report the app exports, captured in scenario 2 and fed back
 *  through the picker in 2b. Null under --quick, which never runs a batch. */
let exportedReport = null;
/** The unpacked bundle labels, re-dropped alongside the report in 2b. */
let bundleLabels = [];

console.log(`round-trip batch harness -> ${BASE}`);
console.log(`workspace: ${work}\n`);

// ---------------------------------------------------------------- scenario 1
// The reported bug. The spreadsheet on its own must produce ONE actionable
// message and build NO rows — not a row per application, each failed.
console.log('1. the sample CSV, downloaded and dropped back in on its own');
{
  const csv = await download('/api/batch-samples/batch.csv', 'batch.csv');
  const r = await dropAndRead([csv]);
  const saysWhy = /on its own/i.test(r.globalError) && /(doesn.t|does not) contain them/i.test(r.globalError);
  const pass = r.rows === 0 && r.errorRows === 0 && saysWhy;
  record('csv-only round trip', pass,
    `rows=${r.rows} (want 0), per-row errors=${r.errorRows} (want 0), banner ${saysWhy ? 'explains why' : 'MISSING/WRONG'}: "${r.globalError.slice(0, 120)}"`);
}

// ---------------------------------------------------------------- scenario 2
// The bundle must round-trip whole: unzip what the app served, feed every file
// back through the picker, and get a complete paired batch.
console.log('\n2. the sample bundle (zip), unpacked and fed back through the picker');
{
  const zip = await download('/api/batch-samples/sample-batch.zip', 'sample-batch.zip');
  const dir = path.join(work, 'bundle');
  fs.mkdirSync(dir, { recursive: true });
  // Unzip without a dependency: the bundle is stored/deflated by our own
  // generator, so Node's zlib handles it via the central directory.
  const buf = fs.readFileSync(zip);
  const files = unzip(buf, dir);
  const r = await dropAndRead(files, { settleMs: 3000 });
  const images = files.filter((f) => /\.(png|jpe?g|webp|pdf)$/i.test(f)).length;
  const pass = r.rows === images && r.pairingIssues === 0 && r.orphanFiles === 0;
  record('zip round trip pairs cleanly', pass,
    `files=${files.length} (${images} labels), rows=${r.rows} (want ${images}), pairing issues=${r.pairingIssues}, orphans=${r.orphanFiles}`);
  if (pass && !QUICK) {
    const t = await waitAndTally();
    record('zip round trip completes', !!t && t.errors === 0 && t.rows === r.rows,
      t ? `checked ${t.rows}, errors=${t.errors}, clean=${t.clean}, needs_review=${t.needsReview}, warning_failure=${t.warningFailures}` : 'no report captured');
    exportedReport = t?.raw ?? null;
    // Keep the unpacked labels for 2b: the report must be re-dropped WITH them.
    bundleLabels = files.filter((f) => /\.(png|jpe?g|webp|pdf)$/i.test(f));
  }
}

// ---------------------------------------------------------------- scenario 2b
// The report the app just produced, fed straight back into the dropzone it came
// from. This is the emit point the other two scenarios missed: the report
// carries EVERY column the batch page requires (filename, brand_name,
// class_type, alcohol_content, net_contents), so it passed validation and ran a
// full batch comparing each label against the literal word "match" — a
// confident mismatch on every field of every row. A loud error is recoverable;
// a wrong verdict sends the agent to re-examine a label that was fine.
//
// Uses the bytes captured from the real export above, not a synthetic file, so
// a change to the export header cannot pass this while breaking the round trip.
if (exportedReport && bundleLabels.length) {
  console.log('\n2b. the report this app produced, dropped back in WITH its labels');
  const out = path.join(work, 'labelcheck-batch-results.csv');
  fs.writeFileSync(out, exportedReport, 'utf8');
  // WITH the labels, deliberately. A CSV dropped alone hits the earlier
  // "spreadsheet on its own" guard (scenario 1) and never reaches the
  // results-export check — so dropping the report by itself would pass this
  // scenario for the wrong reason and leave the real defect untested. The
  // dangerous shape is the one a person actually produces when re-running a
  // batch: the report plus the same label files. The first version of this
  // scenario made exactly that mistake and went red against a build that was
  // already fixed.
  const r = await dropAndRead([out, ...bundleLabels], { settleMs: 3000 });
  const namesIt = /results file this tool produced/i.test(r.globalError);
  const saysWhy = /verdict/i.test(r.globalError);
  const pass = r.rows === 0 && r.errorRows === 0 && namesIt && saysWhy;
  record('report round trip is refused, not silently mis-run', pass,
    `dropped report + ${bundleLabels.length} labels; rows=${r.rows} (want 0), per-row errors=${r.errorRows} (want 0), banner ${namesIt && saysWhy ? 'names it and explains' : 'MISSING/WRONG'}: "${r.globalError.slice(0, 140)}"`);
}

// ---------------------------------------------------------------- scenario 3
// CSVs this repo has never shipped: random labels, random order, application
// values taken from each label's ground-truth sidecar.
console.log(`\n3. ${CSVS} randomised CSV(s) of ${ROWS} labels each, values from the ground-truth sidecars`);
{
  const available = fs.readdirSync(LABELS)
    .filter((f) => f.endsWith('.png'))
    .map((f) => f.replace(/\.png$/, ''))
    .filter((n) => fs.existsSync(path.join(LABELS, `${n}.json`)));

  for (let i = 0; i < CSVS; i++) {
    const chosen = pick(available, Math.min(ROWS, available.length));
    const dir = path.join(work, `random-${i + 1}`);
    fs.mkdirSync(dir, { recursive: true });
    const lines = ['filename,brand_name,class_type,alcohol_content,net_contents'];
    const truth = {};
    for (const name of chosen) {
      const gt = JSON.parse(fs.readFileSync(path.join(LABELS, `${name}.json`), 'utf8'));
      // The route allowlist is irrelevant here — these are local files going
      // through the picker, so the real filenames are used as-is.
      fs.copyFileSync(path.join(LABELS, `${name}.png`), path.join(dir, `${name}.png`));
      truth[`${name}.png`] = gt;
      lines.push([`${name}.png`, gt.brand_name, gt.class_type, gt.alcohol_content, gt.net_contents]
        .map((v) => csvCell(String(v ?? ''))).join(','));
    }
    const csvPath = path.join(dir, 'applications.csv');
    fs.writeFileSync(csvPath, lines.join('\n'), 'utf8');
    const files = [csvPath, ...chosen.map((n) => path.join(dir, `${n}.png`))];

    const r = await dropAndRead(files, { settleMs: 3000 });
    const paired = r.rows === chosen.length && r.pairingIssues === 0 && r.orphanFiles === 0;
    record(`random CSV ${i + 1} pairs (${chosen.join(', ')})`, paired,
      `rows=${r.rows}/${chosen.length}, pairing issues=${r.pairingIssues}, orphans=${r.orphanFiles}`);

    if (paired && !QUICK) {
      const t = await waitAndTally();
      // A label whose sidecar says the warning is canonical must not come back
      // a warning failure — that would be a false rejection on data the repo
      // itself calls clean.
      // "Clean" means the sidecar's verbatim text IS the canonical statement —
      // not merely that it starts with the prefix. The corpus is full of
      // labels that open correctly and then drop or swap a word, and counting
      // those as clean would manufacture false "false rejections". Compared
      // against the shipped canonical text so this cannot drift from the app.
      const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
      const shouldBeClean = Object.entries(truth)
        .filter(([, gt]) => gt.warning_prefix_all_caps === true && norm(gt.warning_text_verbatim) === norm(CANONICAL_WARNING))
        .map(([f]) => f);
      // A label whose OWN sidecar says the warning is canonical must not come
      // back a warning failure. That is a false rejection on data this repo
      // calls clean, and it is the one outcome worth failing the run for —
      // the corpus deliberately contains defect labels, so a bare
      // warning_failure count proves nothing on its own.
      const falseRejections = t
        ? shouldBeClean.filter((f) => t.verdicts[f] === 'warning_failure')
        : [];
      record(`random CSV ${i + 1} completes`, !!t && t.errors === 0 && falseRejections.length === 0,
        t ? `checked ${t.rows}, errors=${t.errors}, clean=${t.clean}, needs_review=${t.needsReview}, warning_failure=${t.warningFailures}; sidecar-clean in set=${shouldBeClean.length}, false rejections=${falseRejections.length}${falseRejections.length ? ' -> ' + falseRejections.join(', ') : ''}` : 'no report captured');
    }
  }
}

await browser.close();

const passed = results.filter((r) => r.pass).length;
const out = {
  ran: new Date().toISOString(),
  base: BASE,
  quick: QUICK,
  seed: Number(arg('seed', 20260814)),
  passed,
  total: results.length,
  results,
  why: 'Closes the loop the other batch harnesses structurally cannot: app output (download link) -> disk -> app input (real file picker). Every other batch test constructs a valid payload in-page and therefore assumes away the step where a user assembles theirs.',
};
// A --quick run must never clobber a full run's record. The evidence file is
// cited by name in approach.md ("Last run: 7/7"), and --quick covers strictly
// less: it stops before any label is checked, so it cannot produce the
// completion scenarios. Overwriting a production full-run record with a local
// pairing-only one silently makes the docs' claim false while every command
// still exits 0 — and it happened, which is why this guard exists.
const reportPath = path.join(ROOT, 'docs', 'round-trip-batch.json');
let prior = null;
try { prior = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { /* first run */ }
if (QUICK && prior && prior.quick === false) {
  console.log(`\n${passed}/${results.length} passed (quick)`);
  console.log(`  NOT written: ${path.relative(ROOT, reportPath)} holds a FULL run`);
  console.log(`  (${prior.passed}/${prior.total} against ${prior.base}, ${prior.ran}).`);
  console.log('  A quick run covers less, so it does not replace that record.');
  console.log('  Re-run without --quick to update the evidence file.');
} else {
  fs.writeFileSync(reportPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`\n${passed}/${results.length} passed -> docs/round-trip-batch.json`);
}
process.exit(passed === results.length ? 0 : 1);

/** Minimal store/deflate unzip via the central directory. */
function unzip(buf, destDir) {
  const out = [];
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip (no end-of-central-directory)');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw);
    const dest = path.join(destDir, path.basename(name));
    fs.writeFileSync(dest, data);
    out.push(dest);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
