/**
 * Pre-read image enhancement: deskew + contrast normalisation.
 *
 * WHY THIS EXISTS — measured, not assumed. Across the 1,360-image degradation
 * matrix the tool never once wrongly rejected an angled or rotated compliant
 * label (zero false rejections), but it could only confirm one clean in
 * **5 of 56 angled (9%)** and **5 of 42 rotated (12%)** cases. The other ~90%
 * went amber "needs review": at a steep tilt the warning genuinely cannot be
 * read character-for-character, and the word-for-word check must not claim a
 * pass on text it could not read. Safe, but it hands a human ~90% of the angled
 * pile — which is exactly the cost the tool exists to remove.
 *
 * Straightening the image before the read attacks the cause rather than the
 * verdict. It cannot make the tool *lenient*: the comparison stays a
 * deterministic string diff, and an enhancement that made the model confident
 * about text it is misreading would show up as a RISE in false rejections. That
 * is the ship/no-ship guard in samples/tools/enhance-ab.mjs, not a nice-to-have.
 *
 * DESIGN CONSTRAINT — this file is pure pixel maths over a Uint8ClampedArray
 * with no DOM, no imports and no closures, so exactly one implementation is
 * shared by:
 *   - the browser upload path (lib/enhanceClient.ts wraps it in a canvas)
 *   - the measurement harness (injected into Playwright via fn.toString())
 *   - unit tests (called directly — no jsdom needed)
 * A second copy is how the bold gate silently drifted out of sync; one function
 * with three callers is the fix.
 */

export interface EnhanceResult {
  /** Explicitly ArrayBuffer-backed (not SharedArrayBuffer) so it can be handed
   *  straight to the ImageData constructor without a defensive copy. */
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  /** Estimated in-plane skew that was corrected, in degrees. 0 = no rotation applied. */
  skewDeg: number;
  /** True when the contrast stretch actually changed anything. */
  contrastApplied: boolean;
}

/**
 * Deskew and normalise. Deliberately close to a no-op on an already-clean
 * image: rotation is skipped below MIN_SKEW_DEG and the stretch is skipped when
 * the histogram already spans the range.
 */
export function enhanceImage(
  src: Uint8ClampedArray,
  width: number,
  height: number,
): EnhanceResult {
  const MIN_SKEW_DEG = 0.75; // below this, rotation resampling costs more than it buys
  const MAX_SKEW_DEG = 20;
  const INK_DELTA = 55; // same ink/background separation the bold measurement uses

  // ---- luminance + background estimate ----
  const n = width * height;
  const lum = new Float32Array(n);
  for (let i = 0, p = 0; p < n; i += 4, p++) {
    lum[p] = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
  }
  // Modal luminance = the paper, robust to a dark label occupying a minority.
  const hist = new Array(32).fill(0);
  for (let p = 0; p < n; p++) hist[Math.min(31, (lum[p] / 8) | 0)]++;
  let modeBin = 0;
  for (let b = 1; b < 32; b++) if (hist[b] > hist[modeBin]) modeBin = b;
  const bg = modeBin * 8 + 4;

  // ---- skew estimate on a downsampled ink point cloud ----
  // Projection-profile criterion: when text lines are level, ink concentrates
  // into few rows, so the row-count histogram has high variance. Sampling the
  // ink rather than every pixel keeps the angle sweep cheap.
  // Subsample COLUMNS only. Text lines sit ~8-12px apart, so skipping rows
  // aliases away the exact periodic structure the projection relies on — an
  // earlier version stepped both axes by ~6px and detected skew on 0 of 12
  // visibly rotated labels. Vertical resolution is the signal; horizontal is
  // just sample count.
  const stepX = Math.max(1, Math.round(width / 300));
  const xs: number[] = [];
  const ys: number[] = [];
  const cx = width / 2;
  const cy = height / 2;
  // Select on local GRADIENT, not on ink-vs-background. A dark label makes the
  // modal background the label itself, so the pale padding a rotated render
  // adds around the artwork registers as ink — an axis-aligned rectangle of it,
  // which pinned the estimate to 0deg on every rotation past the mildest.
  // Gradient fires on letter strokes and ignores flat regions entirely,
  // whatever their colour.
  for (let y = 1; y < height - 1; y++) {
    for (let x = stepX; x < width - 1; x += stepX) {
      const i = y * width + x;
      const gx = Math.abs(lum[i + 1] - lum[i - 1]);
      const gy = Math.abs(lum[i + width] - lum[i - width]);
      if (gx + gy > INK_DELTA) {
        xs.push(x - cx);
        ys.push(y - cy);
      }
    }
  }

  let skewDeg = 0;
  // Too little ink to reason about; leave geometry alone rather than guess.
  if (xs.length >= 200) {
    const diag = Math.ceil(Math.hypot(width, height)) + 2;
    const rows = new Float64Array(diag);
    let bestScore = -1;
    for (let deg = -MAX_SKEW_DEG; deg <= MAX_SKEW_DEG; deg += 0.5) {
      const rad = (deg * Math.PI) / 180;
      const sin = Math.sin(rad);
      const cos = Math.cos(rad);
      rows.fill(0);
      for (let k = 0; k < xs.length; k++) {
        const ry = (-xs[k] * sin + ys[k] * cos + diag / 2) | 0;
        if (ry >= 0 && ry < diag) rows[ry]++;
      }
      // Sum of squares peaks when ink piles into few rows (equivalent to
      // variance here, since the total is constant across angles).
      let score = 0;
      for (let r = 0; r < diag; r++) score += rows[r] * rows[r];
      if (score > bestScore) {
        bestScore = score;
        skewDeg = deg;
      }
    }
  }

  // NO CONTRAST STRETCH — deliberately removed after measurement, twice over.
  //
  // 1. It was dangerous. A 5th/95th percentile stretch assumes the percentiles
  //    bracket the content, but a label is mostly white margin: on
  //    batch-mismatch-brand--pristine both percentiles land on 250, so span
  //    collapsed to 1 and the "stretch" binarised the entire image (mean pixel
  //    shift 246 of 255). It damaged the CLEAN path, not just degraded inputs.
  // 2. It was aimed at a problem we do not have. Baseline confirmed-clean rates
  //    are already 79% under low light and 75% under glare. The weak axes are
  //    angle (9%) and rotation (12%) — geometry, not exposure.
  //
  // Rejected alternatives: capping the gain and widening the percentiles both
  // survive the pathological case but neither had a measured benefit to justify
  // modifying every uploaded pixel. Geometry is the whole win here.
  const contrastApplied = false;

  const applyRotation = Math.abs(skewDeg) >= MIN_SKEW_DEG;
  if (!applyRotation) {
    // Byte-identical passthrough. lib/downscale.ts uses this to return the
    // user's ORIGINAL file, so an already-straight label is never re-encoded.
    return { data: src as Uint8ClampedArray<ArrayBuffer>, width, height, skewDeg: 0, contrastApplied };
  }

  // ---- rotate by -skew into an expanded canvas ----
  // Expanded so corners are never clipped; padding is the estimated paper
  // colour, because black corners read as damage to a vision model.
  const rad = (-skewDeg * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const outW = Math.ceil(Math.abs(width * cos) + Math.abs(height * sin));
  const outH = Math.ceil(Math.abs(width * sin) + Math.abs(height * cos));
  const out = new Uint8ClampedArray(outW * outH * 4);
  const pad = bg;
  const ocx = outW / 2;
  const ocy = outH / 2;

  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      // Inverse map with bilinear sampling — nearest-neighbour on text this
      // small produces stair-stepping that reads as blur to the model.
      const dx = ox - ocx;
      const dy = oy - ocy;
      const sx = dx * cos + dy * sin + cx;
      const sy = -dx * sin + dy * cos + cy;
      const o = (oy * outW + ox) * 4;
      if (sx < 0 || sy < 0 || sx >= width - 1 || sy >= height - 1) {
        out[o] = out[o + 1] = out[o + 2] = pad;
        out[o + 3] = 255;
        continue;
      }
      const x0 = sx | 0;
      const y0 = sy | 0;
      const fx = sx - x0;
      const fy = sy - y0;
      const rgb = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const i00 = (y0 * width + x0) * 4 + c;
        const i10 = (y0 * width + x0 + 1) * 4 + c;
        const i01 = ((y0 + 1) * width + x0) * 4 + c;
        const i11 = ((y0 + 1) * width + x0 + 1) * 4 + c;
        const top = src[i00] + (src[i10] - src[i00]) * fx;
        const bot = src[i01] + (src[i11] - src[i01]) * fx;
        rgb[c] = top + (bot - top) * fy;
      }
      out[o] = rgb[0];
      out[o + 1] = rgb[1];
      out[o + 2] = rgb[2];
      out[o + 3] = 255;
    }
  }

  return { data: out, width: outW, height: outH, skewDeg, contrastApplied };
}
