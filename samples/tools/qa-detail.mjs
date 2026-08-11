// Re-shoot only the batch detail panel (compact layout verification).
import { chromium } from 'playwright';

const OUT = 'C:/Users/merit/AppData/Local/Temp/claude/C--Users-merit-OneDrive-Desktop-labelcheck/1374f1af-691b-4db5-aacd-68f45396624e/scratchpad/qa';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
await page.goto('http://localhost:3000/batch');
await page.getByRole('button', { name: /Run the sample batch/ }).click();
await page.waitForSelector('text=Checked in', { timeout: 120000 });
await page.getByRole('button', { name: /^Need review/ }).click();
await page.waitForTimeout(300);
await page.locator('tbody tr', { hasText: 'warning-fail.png' }).first().click();
await page.waitForSelector('text=Audit trail', { timeout: 10000 });
await page.waitForTimeout(4500);
await page.screenshot({ path: `${OUT}/7-batch-detail.png`, fullPage: false });
console.log('detail shot done');
await browser.close();
