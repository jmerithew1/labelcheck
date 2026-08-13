import { describe, it, expect } from "vitest";
import { enhanceImage } from "./enhance.ts";

/**
 * Synthesise a label-ish image: light paper with dark horizontal text lines.
 * `rotateDeg` tilts the lines, which is what the deskew estimator must recover.
 */
function makeLabel(width: number, height: number, rotateDeg = 0, contrast = 255) {
  const data = new Uint8ClampedArray(width * height * 4);
  const paper = contrast;
  const ink = 255 - contrast;
  const rad = (rotateDeg * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const cx = width / 2;
  const cy = height / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Inverse-rotate into text space, then draw a line every 10px.
      const dx = x - cx;
      const dy = y - cy;
      const ty = -dx * sin + dy * cos + cy;
      const tx = dx * cos + dy * sin + cx;
      const inBody = tx > width * 0.15 && tx < width * 0.85 && ty > height * 0.15 && ty < height * 0.85;
      const onLine = Math.abs((((ty % 10) + 10) % 10) - 2) < 1.5;
      const v = inBody && onLine ? ink : paper;
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return data;
}

describe("enhanceImage", () => {
  it("recovers a known rotation to within the half-degree search step", () => {
    const w = 200, h = 200;
    for (const truth of [-8, -3, 4, 9]) {
      const out = enhanceImage(makeLabel(w, h, truth), w, h);
      // The estimator finds the skew; the correction is the negation of it.
      expect(Math.abs(out.skewDeg - truth)).toBeLessThanOrEqual(1);
    }
  });

  it("leaves a level image un-rotated", () => {
    const w = 200, h = 200;
    const out = enhanceImage(makeLabel(w, h, 0), w, h);
    expect(out.skewDeg).toBe(0);
    expect(out.width).toBe(w);
    expect(out.height).toBe(h);
  });

  it("no longer applies any contrast stretch (removed: it binarised mostly-white labels)", () => {
    const w = 120, h = 120;
    const out = enhanceImage(makeLabel(w, h, 0, 255), w, h);
    expect(out.contrastApplied).toBe(false);
  });

  it("leaves a washed-out image byte-identical rather than risk the stretch", () => {
    const w = 120, h = 120;
    // Low-contrast: paper 150, ink 105 — the low-light/glare failure shape.
    const src = makeLabel(w, h, 0, 150);
    const out = enhanceImage(src, w, h);
    expect(out.contrastApplied).toBe(false);
    expect(out.skewDeg).toBe(0);
    expect(Array.from(out.data)).toEqual(Array.from(src));
  });

  // Regression: a label is mostly white margin, so the 5th AND 95th percentile
  // both landed on the paper value. span collapsed to 1, and the stretch that
  // was meant to lift contrast binarised the whole image instead — measured at
  // a mean pixel shift of 246/255 on batch-mismatch-brand--pristine, i.e. it
  // destroyed a CLEAN label. Nothing may touch pixel values on the no-rotation
  // path again.
  it("never alters pixel values on a mostly-uniform label", () => {
    const w = 100, h = 100;
    const src = new Uint8ClampedArray(w * h * 4).fill(250);
    for (let p = 0; p < w * h; p++) src[p * 4 + 3] = 255;
    // a sliver of dark ink, well under the 5th percentile
    for (let p = 0; p < 120; p++) {
      src[p * 4] = src[p * 4 + 1] = src[p * 4 + 2] = 10;
    }
    const out = enhanceImage(src, w, h);
    expect(out.skewDeg).toBe(0);
    expect(Array.from(out.data)).toEqual(Array.from(src));
  });

  it("expands the canvas when rotating so no corner is clipped", () => {
    const w = 200, h = 200;
    const out = enhanceImage(makeLabel(w, h, 10), w, h);
    expect(out.width).toBeGreaterThan(w);
    expect(out.height).toBeGreaterThan(h);
    expect(out.data.length).toBe(out.width * out.height * 4);
  });

  it("leaves geometry alone when there is too little ink to judge", () => {
    const w = 60, h = 60;
    const blank = new Uint8ClampedArray(w * h * 4).fill(255);
    const out = enhanceImage(blank, w, h);
    expect(out.skewDeg).toBe(0);
  });
});
