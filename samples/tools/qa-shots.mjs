// Screenshot QA: drives every mockup state against a running local server and
// captures each. Run: node qa-shots.mjs  (server on :3000 with API key)
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LABELS = path.resolve(__dirname, '..', 'labels');
const OUT = 'C:/Users/merit/AppData/Local/Temp/claude/C--Users-merit-OneDrive-Desktop-labelcheck/1374f1af-691b-4db5-aacd-68f45396624e/scratchpad/qa';
const BASE = 'http://localhost:3000';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });

// 1. Single input state
await page.goto(BASE);
await page.waitForTimeout(800);
await shot('1-input');

// 2. Success state (clean match example)
await page.getByRole('button', { name: /Clean match/ }).click();
await page.waitForSelector('text=Label matches the application', { timeout: 30000 });
await page.waitForTimeout(3500); // OCR + highlight hydration
await shot('2-success');

// 3. Warning-issue state (title case → red, auto-highlight + connector)
await page.getByRole('button', { name: /Check another label/ }).click();
await page.getByRole('button', { name: /Warning issue/ }).click();
await page.waitForSelector('text=needs review', { timeout: 30000 });
await page.waitForTimeout(3500);
await shot('3-warning-issue');

// 4. Complex case: word-swap label uploaded with a WRONG ABV in the form → 2+ issues
await page.getByRole('button', { name: /Check another label/ }).click();
await page.getByLabel('Brand name', { exact: true }).fill('OLD TOM DISTILLERY');
await page.getByLabel('Class / Type', { exact: true }).fill('Kentucky Straight Bourbon Whiskey');
await page.getByLabel('Alcohol content', { exact: true }).fill('40% Alc./Vol. (80 Proof)');
await page.getByLabel('Net contents', { exact: true }).fill('750 mL');
await page.locator('input[type="file"]').setInputFiles(path.join(LABELS, 'word-swap.png'));
await page.waitForTimeout(400);
await page.getByRole('button', { name: /Check label/ }).click();
await page.waitForSelector('text=need review', { timeout: 40000 });
await page.waitForTimeout(3500);
await shot('4-complex');

// 5. Batch empty
await page.goto(BASE + '/batch');
await page.waitForTimeout(800);
await shot('5-batch-empty');

// 6. Batch complete + detail panel
await page.getByRole('button', { name: /Run the sample batch/ }).click();
await page.waitForSelector('text=Checked in', { timeout: 120000 });
await page.waitForTimeout(600);
await shot('6-batch-complete');
const reviewChip = page.getByRole('button', { name: /^Need review/ });
await reviewChip.click();
await page.waitForTimeout(300);
await page.locator('tbody tr', { hasText: 'warning-fail.png' }).first().click();
await page.waitForSelector('text=Audit trail', { timeout: 10000 });
await page.waitForTimeout(4000); // lazy bands + OCR
await shot('7-batch-detail');

console.log('QA shots complete');
await browser.close();
