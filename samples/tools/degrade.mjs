// Degraded-input variants: photo-like abuse (blur, perspective, glare) applied
// to ground-truthed labels, for measuring extraction fidelity beyond crisp
// renders. Run from samples/tools: node degrade.mjs
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const labelsDir = path.join(here, "..", "labels");
const outDir = path.join(here, "..", "degraded");
fs.mkdirSync(outDir, { recursive: true });

const BASES = ["clean-match", "title-case-prefix", "word-swap", "small-warning", "wine-label"];

const VARIANTS = {
  blur: `filter: blur(1.3px) contrast(0.82) brightness(1.05) saturate(0.9);`,
  tilt: `transform: perspective(900px) rotateY(16deg) rotateX(5deg) scale(0.92); filter: contrast(0.9);`,
  glare: `filter: contrast(0.75) brightness(1.1);`,
};

const glareOverlay = `
  <div style="position:absolute; inset:0; pointer-events:none;
    background: radial-gradient(ellipse 40% 22% at 52% 78%, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.35) 55%, transparent 75%),
                radial-gradient(ellipse 30% 18% at 30% 30%, rgba(255,255,255,0.5) 0%, transparent 70%);"></div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 1300 } });

for (const base of BASES) {
  const png = path.join(labelsDir, `${base}.png`);
  const b64 = fs.readFileSync(png).toString("base64");
  for (const [name, style] of Object.entries(VARIANTS)) {
    const html = `<!doctype html><body style="margin:0; background:#777; display:flex; align-items:center; justify-content:center; width:900px; height:1300px;">
      <div style="position:relative; ${style}">
        <img src="data:image/png;base64,${b64}" style="max-width:820px; max-height:1200px; display:block;"/>
        ${name === "glare" ? glareOverlay : ""}
      </div></body>`;
    await page.setContent(html);
    await page.waitForTimeout(120);
    const out = path.join(outDir, `${base}--${name}.png`);
    await page.screenshot({ path: out });
    const size = fs.statSync(out).size;
    if (size < 5000) throw new Error(`${out} looks empty (${size} bytes)`);
    console.log(`${base}--${name}.png (${Math.round(size / 1024)} KB)`);
  }
}
await browser.close();
console.log("degraded set complete");
