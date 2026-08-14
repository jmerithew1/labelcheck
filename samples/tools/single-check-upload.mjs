// Does the SINGLE-CHECK page behave the same for a file a user uploads as it
// does for a demo sample card?
//
// The two share runCheck() and render the same ResultView, so the answer
// "should" be yes by construction. "Shared code path, therefore fine" is
// exactly the reasoning that missed the sample-CSV trap, so this drives the
// real file picker (setInputFiles) with a label that is NOT a demo card and
// NOT in the sample batch — a file the app has never served — and checks the
// things a person would notice:
//
//   * the government warning is listed in the comparison table (any verdict)
//   * the audit trail exists, sits INSIDE the result card above the actions,
//     and names the uploaded file — the one line only an upload exercises,
//     since a sample card names the sample
//   * clicking the warning row draws something, either its located band or
//     the captioned foot-of-label fallback
//
//   node single-check-upload.mjs [base-url] [label-name]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:3011';
const LABEL = process.argv[3] || 'allcaps-body';
const ROOT = 'C:/dev/labelcheck';
const img = path.join(ROOT, 'samples', 'labels', `${LABEL}.png`);
const gt = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'labels', `${LABEL}.json`), 'utf8'));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
await page.goto(BASE, { waitUntil: 'networkidle' });

// Type into the form and choose a file, exactly as a person would.
await page.getByPlaceholder('Enter brand name').fill(gt.brand_name);
await page.locator('input[type=file]').first().setInputFiles(img);
await page.waitForTimeout(600);
await page.getByRole('button', { name: /^Check label/ }).click();

// Wait for the verdict.
for (let i = 0; i < 60; i++) {
  if (await page.locator('[data-row="warning"]').count()) break;
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(2500);

const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const overlays = () => [...document.querySelectorAll('span,div')]
    .filter((e) => e.style && e.style.top && e.style.height && /absolute/.test(e.className || '')).length;
  const warn = document.querySelector('[data-row="warning"]');
  const det = document.querySelector('details.print-open');
  const printBtn = [...document.querySelectorAll('button')].find((b) => /Print report/.test(b.innerText));
  const res = {
    warningRowPresent: !!warn,
    warningChip: warn ? (warn.innerText.match(/Fail|Review|Pass/) || [''])[0] : null,
    auditTrailPresent: !!det,
    auditTrailInsideCard: !!(det && det.closest('[data-conn-root]')),
    auditTrailAboveActions: !!(det && printBtn && (det.compareDocumentPosition(printBtn) & Node.DOCUMENT_POSITION_FOLLOWING)),
  };
  if (det) {
    det.querySelector('summary').click();
    await sleep(400);
    res.auditTrailNamesTheUploadedFile = /allcaps-body\.png/.test(det.innerText);
    res.auditTrailFirstLine = (det.innerText.match(/Label uploaded[\s\S]{0,90}/) || [''])[0].replace(/\n/g, ' ');
  }
  const base = overlays();
  warn.click();
  await sleep(900);
  res.warningClickDrawsBox = overlays() > base;
  res.caption = (document.querySelector('main').innerText.match(/(Couldn|Click any row)[^\n]*/) || [''])[0].slice(0, 100);
  res.rowsClickable = getComputedStyle(document.querySelector('[data-row="brand_name"]')).cursor;
  return res;
});

await browser.close();

const checks = [
  ['government warning listed in the comparison table', out.warningRowPresent, out.warningChip],
  ['audit trail present', out.auditTrailPresent, ''],
  ['audit trail inside the result card', out.auditTrailInsideCard, ''],
  ['audit trail above the action row', out.auditTrailAboveActions, ''],
  ['audit trail names the uploaded file', out.auditTrailNamesTheUploadedFile, out.auditTrailFirstLine],
  ['warning row click draws something', out.warningClickDrawsBox, out.caption],
  ['rows offer a pointer cursor', out.rowsClickable === 'pointer', out.rowsClickable],
];
console.log(`uploaded ${LABEL}.png through the real file picker -> ${BASE}
`);
let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `
        ${String(detail).slice(0, 110)}` : ''}`);
}
console.log(`
${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
