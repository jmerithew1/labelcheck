"use client";

import type { BoldSignals } from "./compare/boldGate.ts";
import { createPool } from "./pool.ts";

/**
 * Browser-side measurement for the multi-signal bold gate: crop the warning
 * band from the label image, 3x smooth upscale + contrast stretch (the
 * pre-processing validated in the spike loop), OCR the crop to find the
 * prefix and a body reference word, then measure stroke width / ink density /
 * cap height for both. Mirrors samples/tools/bold-multisignal-r2.mjs, which
 * is where these choices earned their validation numbers.
 * Returns null when anything is unmeasurable — the gate treats that as
 * "human". OCR runs on a small pool of workers (see below).
 */

type OcrWorker = import("tesseract.js").Worker;

/**
 * OCR worker pool.
 *
 * Every measurement is a tesseract pass, and these used to be serialized
 * through a single worker. Measured on the deployed app with 250 labels: the
 * opt-in bold pass resolved about FOUR ROWS PER MINUTE and would have taken
 * over ten minutes to finish the batch — because a row whose warning band is
 * missing or wrong costs a second full-image OCR to repair it, and every one
 * of those queued behind every other. The check pass itself does 250 labels in
 * ~140s, so the bold pass was the only part of the batch that did not scale.
 *
 * Workers are expensive (WASM + language data each), so the pool grows LAZILY:
 * a new one is created only when every existing worker is busy and the cap has
 * not been reached. A single-label check therefore still spins up exactly one,
 * while a 250-row batch reaches the cap and stays there.
 *
 * The cap is deliberately conservative. These run on government laptops, and
 * each worker holds its own WASM heap; leaving a core free keeps the main
 * thread responsive, which matters because the crop preparation below is
 * main-thread canvas work.
 */
const MAX_OCR_WORKERS = (() => {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined;
  if (!cores || !Number.isFinite(cores)) return 2; // unknown hardware: modest default
  return Math.min(4, Math.max(1, cores - 1));
})();

const ocrPool = createPool<OcrWorker>({
  max: MAX_OCR_WORKERS,
  create: () => import("tesseract.js").then(({ createWorker }) => createWorker("eng")),
});

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

interface Box { x0: number; y0: number; x1: number; y1: number }

function lumRows(ctx: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number): Float32Array[] {
  const d = ctx.getImageData(x0, y0, w, h).data;
  const rows: Float32Array[] = [];
  for (let y = 0; y < h; y++) {
    const row = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      row[x] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    rows.push(row);
  }
  return rows;
}

function modalBg(rows: Float32Array[]): number {
  const hist = new Array(10).fill(0);
  for (const row of rows) for (const v of row) hist[Math.min(9, Math.floor(v / 25.6))]++;
  return hist.indexOf(Math.max(...hist)) * 25.6 + 12.8;
}

function measureBox(rows: Float32Array[], bg: number): { capH: number; inkFrac: number; sw: number } | null {
  if (!rows.length) return null;
  const h = rows.length, w = rows[0].length;
  const ink: boolean[][] = rows.map((row) => Array.from(row, (v) => Math.abs(v - bg) > 55));
  const perRow = ink.map((r) => r.reduce((a, b) => a + (b ? 1 : 0), 0));
  const act = perRow.map((n, y) => (n > w * 0.02 ? y : -1)).filter((y) => y >= 0);
  if (act.length < 2) return null;
  const capH = act[act.length - 1] - act[0] + 1;
  let inkPx = 0, totPx = 0;
  for (const y of act) { inkPx += perRow[y]; totPx += w; }
  const runH = ink.map((row) => {
    const out = new Int16Array(w);
    let x = 0;
    while (x < w) {
      if (!row[x]) { x++; continue; }
      let e = x; while (e < w && row[e]) e++;
      for (let i = x; i < e; i++) out[i] = e - x;
      x = e;
    }
    return out;
  });
  const runV: Int16Array[] = [];
  for (let y = 0; y < h; y++) runV.push(new Int16Array(w));
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!ink[y][x]) { y++; continue; }
      let e = y; while (e < h && ink[e][x]) e++;
      for (let i = y; i < e; i++) runV[i][x] = e - y;
      y = e;
    }
  }
  const widths: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (ink[y][x]) widths.push(Math.min(runH[y][x], runV[y][x]));
  if (widths.length < 20) return null;
  widths.sort((a, b) => a - b);
  return { capH, inkFrac: inkPx / totPx, sw: widths[Math.floor(widths.length / 2)] };
}

/**
 * Find the warning band by reading the image, when the AI locator's band is
 * missing or wrong.
 *
 * The locator is a single vision call returning approximate bands, and it does
 * miss: on one sample it put the warning at 47% of a label whose warning sits
 * at ~90%, and on another it returned no warning band at all. The crop drives
 * both the strip's magnifier and the bold measurement, so a wrong band shows
 * the agent the wrong part of the label and burns a human glance on a row the
 * machine could have resolved. (It cannot cause a false "bold" — the
 * measurement needs to actually find GOVERNMENT and a body word in the crop,
 * and a wrong crop simply yields null → "human".)
 *
 * Returns permille [top, bottom] like the locator, or null if the warning
 * genuinely isn't readable.
 */
export async function ocrWarningBand(imageUrl: string): Promise<[number, number] | null> {
  // Claim a worker BEFORE decoding the image: on a 250-row batch every row
  // fires at once, and acquiring first means at most MAX_OCR_WORKERS images
  // are decoded concurrently instead of 250 sitting in memory waiting for a
  // turn. The wait costs nothing — decoding is main-thread work that could not
  // have run in parallel anyway.
  const worker = await ocrPool.acquire();
  if (!worker) return null;
  try {
    const img = await loadImage(imageUrl);
    if (!img) return null;
    const H = img.naturalHeight;
    const recognized = await worker.recognize(imageUrl, {}, { blocks: true }).catch(() => null);
    if (!recognized) return null;

    const words: { text: string; y0: number; y1: number }[] = [];
    for (const b of (recognized as { data: { blocks?: Array<{ paragraphs: Array<{ lines: Array<{ words: Array<{ text: string; bbox: Box }> }> }> }> } }).data.blocks ?? [])
      for (const p of b.paragraphs)
        for (const l of p.lines)
          for (const w of l.words) words.push({ text: w.text.toUpperCase().replace(/[^A-Z]/g, ""), y0: w.bbox.y0, y1: w.bbox.y1 });

    const start = words.find((w) => w.text.startsWith("GOVERNMENT"));
    if (!start) return null;
    // The statement ends at "problems." — take the last body keyword at or
    // below the prefix so the band covers the whole block, not just line one.
    const tail = words.filter((w) => w.y0 >= start.y0 && /^(PROBLEMS|MACHINERY|HEALTH|BIRTH|DEFECTS|IMPAIRS|ABILITY)/.test(w.text));
    const bottom = tail.length ? Math.max(...tail.map((w) => w.y1)) : start.y1;
    if (bottom <= start.y0) return null;
    return [Math.round((start.y0 / H) * 1000), Math.round((bottom / H) * 1000)];
  } catch {
    return null;
  } finally {
    ocrPool.release(worker);
  }
}

/** band = [topPermille, bottomPermille] from the AI locator. */
export async function measureBoldSignals(
  imageUrl: string,
  band: [number, number],
): Promise<BoldSignals | null> {
  // Acquired before the crop is built, for the same reason as above: the pool
  // then bounds peak memory as well as concurrency. Every eligible row in a
  // batch calls this at once, and each crop is a canvas three times the width
  // of the label.
  const worker = await ocrPool.acquire();
  if (!worker) return null;
  try {
    const img = await loadImage(imageUrl);
    if (!img) return null;
    const W = img.naturalWidth, H = img.naturalHeight;
    const topF = Math.max(0, band[0] / 1000 - 0.015);
    const botF = Math.min(1, band[1] / 1000 + 0.015);
    const y0 = Math.round(topF * H), ch = Math.round((botF - topF) * H);
    if (ch < 4 || W < 8) return null;

    const S = 3;
    const canvas = document.createElement("canvas");
    canvas.width = W * S;
    canvas.height = ch * S;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, y0, W, ch, 0, 0, canvas.width, canvas.height);

    // Contrast stretch (5th→95th percentile) — the validated pre-processing.
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const lums = new Float32Array(d.data.length / 4);
    for (let i = 0, p = 0; i < d.data.length; i += 4, p++)
      lums[p] = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
    const sorted = Float32Array.from(lums).sort();
    const lo = sorted[Math.floor(sorted.length * 0.05)], hi = sorted[Math.floor(sorted.length * 0.95)];
    const span = Math.max(1, hi - lo);
    for (let i = 0, p = 0; i < d.data.length; i += 4, p++) {
      const v = Math.max(0, Math.min(255, ((lums[p] - lo) / span) * 255));
      d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
    }
    ctx.putImageData(d, 0, 0);

    // OCR the crop (serialized on the shared worker).
    const dataUrl = canvas.toDataURL("image/png");
    const recognized = await worker.recognize(dataUrl, {}, { blocks: true }).catch(() => null);
    if (!recognized) return null;
    const words: { text: string; x0: number; y0: number; x1: number; y1: number }[] = [];
    for (const b of (recognized as { data: { blocks?: Array<{ paragraphs: Array<{ lines: Array<{ words: Array<{ text: string; bbox: Box }> }> }> }> } }).data.blocks ?? [])
      for (const p of b.paragraphs)
        for (const l of p.lines)
          for (const w of l.words) words.push({ text: w.text.toUpperCase(), ...w.bbox });
    const clean = (t: string) => t.replace(/[^A-Z0-9]/g, "");
    const prefix = words.find((w) => clean(w.text).startsWith("GOVERNMENT"));
    const body =
      words.find((w) => clean(w.text).startsWith("ACCORDING")) ??
      words.find((w) => clean(w.text).startsWith("CONSUMPTION")) ??
      words.find((w) => clean(w.text).startsWith("BEVERAGES"));
    if (!prefix || !body) return null;

    const crop = (b: Box) => {
      const x0 = Math.max(0, b.x0 - 2), y0c = Math.max(0, b.y0 - 2);
      const w = Math.min(b.x1 - b.x0 + 4, canvas.width - x0);
      const h = Math.min(b.y1 - b.y0 + 4, canvas.height - y0c);
      if (w < 4 || h < 4) return null;
      return lumRows(ctx, x0, y0c, w, h);
    };
    const bodyRows = crop(body), prefRows = crop(prefix);
    if (!bodyRows || !prefRows) return null;
    const bg = modalBg(bodyRows);
    const bm = measureBox(bodyRows, bg), pm = measureBox(prefRows, bg);
    if (!bm || !pm) return null;
    return {
      swRatio: pm.sw / bm.sw,
      densRatio: pm.inkFrac / bm.inkFrac,
      sizeRatio: pm.capH / bm.capH,
      // Absolute width of the BODY stroke in the source image's own pixels.
      // Measured on a 3x upscale, so divide back out. The gate uses this to
      // refuse a verdict when the image simply lacks the resolution to carry
      // one — a ratio of small integers looks precise and is not.
      swBodyNativePx: bm.sw / 3,
    };
  } catch {
    return null;
  } finally {
    ocrPool.release(worker);
  }
}
