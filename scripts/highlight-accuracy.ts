/**
 * Highlight-accuracy harness: runs the REAL matching pipeline (matchExact /
 * matchBlock from lib/highlight.ts) over every sample label that has
 * generator-emitted ground-truth boxes, and scores each field:
 *   - exact layer: predicted region must CONTAIN the truth center, IoU >= 0.5
 *   - band fallback counts as "band" (not scored for IoU — approximate by design)
 * Gate (plan Part A.3): >= 90% of exact-layer matches must pass.
 * Run: node scripts/highlight-accuracy.ts   → writes docs/highlight-accuracy.json
 */
import fs from "node:fs";
import path from "node:path";
import { createWorker } from "tesseract.js";
import { matchExact, matchBlock, type OcrIndex } from "../lib/highlight.ts";

const root = path.join(import.meta.dirname, "..");
const labelsDir = path.join(root, "samples", "labels");

/** PNG IHDR width/height — true image dimensions without a browser. */
function pngDims(file: string): { width: number; height: number } {
  const buf = fs.readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

interface Truth { left: number; top: number; width: number; height: number }

function iou(a: Truth, b: Truth): number {
  const x0 = Math.max(a.left, b.left);
  const y0 = Math.max(a.top, b.top);
  const x1 = Math.min(a.left + a.width, b.left + b.width);
  const y1 = Math.min(a.top + a.height, b.top + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

async function main() {
  const boxFiles = fs.readdirSync(labelsDir).filter((f) => f.endsWith(".boxes.json"));
  const worker = await createWorker("eng");
  const rows: Record<string, unknown>[] = [];
  let exactPass = 0, exactFail = 0, bandFallback = 0, skipped = 0;

  for (const bf of boxFiles) {
    const name = bf.replace(".boxes.json", "");
    const truths: Record<string, Truth> = JSON.parse(fs.readFileSync(path.join(labelsDir, bf), "utf8"));
    const sidecar = JSON.parse(fs.readFileSync(path.join(labelsDir, `${name}.json`), "utf8"));
    const png = path.join(labelsDir, `${name}.png`);
    const dims = pngDims(png);

    const { data } = await worker.recognize(png, {}, { blocks: true });
    const index: OcrIndex = { words: [], lines: [], width: dims.width, height: dims.height };
    for (const b of data.blocks ?? []) {
      for (const p of b.paragraphs) {
        for (const l of p.lines) {
          index.lines.push({ text: l.text, ...l.bbox });
          for (const w of l.words) index.words.push({ text: w.text, ...w.bbox });
        }
      }
    }

    const fieldTexts: Record<string, string | undefined> = {
      brand_name: sidecar.brand_name,
      class_type: sidecar.class_type,
      alcohol_content: sidecar.alcohol_content,
      net_contents: sidecar.net_contents,
      warning: sidecar.warning_text_verbatim,
    };

    for (const [field, text] of Object.entries(fieldTexts)) {
      const truth = truths[field];
      if (!truth || !text) { skipped++; continue; }
      const region = field === "warning" ? matchBlock(index, text) : matchExact(index, text);
      if (!region) {
        bandFallback++;
        rows.push({ label: name, field, outcome: "band_fallback" });
        continue;
      }
      const pred: Truth = {
        left: region.left / 100, top: region.top / 100,
        width: region.width / 100, height: region.height / 100,
      };
      const cx = truth.left + truth.width / 2;
      const cy = truth.top + truth.height / 2;
      const containsCenter =
        cx >= pred.left && cx <= pred.left + pred.width &&
        cy >= pred.top && cy <= pred.top + pred.height;
      const overlap = iou(pred, truth);
      const pass = containsCenter && overlap >= 0.5;
      if (pass) exactPass++; else exactFail++;
      rows.push({
        label: name, field, outcome: pass ? "pass" : "FAIL",
        iou: Math.round(overlap * 100) / 100, containsCenter,
      });
      if (!pass) console.log(`FAIL ${name}/${field}: iou=${overlap.toFixed(2)} center=${containsCenter} pred=${JSON.stringify(pred)} truth=${JSON.stringify(truth)}`);
    }
    console.log(`${name}: done`);
  }
  await worker.terminate();

  const exactTotal = exactPass + exactFail;
  const rate = exactTotal ? exactPass / exactTotal : 0;
  const summary = {
    measured_at: new Date().toISOString(),
    exact_pass: exactPass, exact_fail: exactFail,
    exact_pass_rate: Math.round(rate * 1000) / 10,
    band_fallbacks: bandFallback, skipped_no_truth: skipped,
    gate: rate >= 0.9 ? "PASS (>=90%)" : "FAIL (<90%)",
  };
  fs.writeFileSync(path.join(root, "docs", "highlight-accuracy.json"), JSON.stringify({ summary, rows }, null, 2));
  console.log("\n" + JSON.stringify(summary, null, 2));
  process.exit(rate >= 0.9 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
