import { enhanceImage } from "./enhance.ts";

/**
 * Client-side upload preparation: downscale, then deskew + normalise.
 *
 * Downscale first (≤1568px long edge — vision models see nothing extra above
 * this, and upload bandwidth was a measured batch bottleneck), then enhance the
 * smaller buffer. Enhancing first would rotate millions of pixels that are
 * about to be thrown away.
 *
 * Both steps live in ONE function on purpose. Enhancement has four call sites
 * across the single-check and batch paths, and a step that must be remembered
 * at four call sites is a step that eventually gets missed at one.
 *
 * Non-images (PDFs) pass through untouched — Claude reads those as document
 * blocks, where a raster rotation would be meaningless.
 */
export async function prepareImage(file: File, maxEdge = 1568): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file; // unreadable as an image — let the server reject loudly

  const longEdge = Math.max(bitmap.width, bitmap.height);
  const scale = longEdge > maxEdge ? maxEdge / longEdge : 1;
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, w, h);

  let rotated = false;
  try {
    const src = ctx.getImageData(0, 0, w, h);
    const out = enhanceImage(src.data, w, h);
    rotated = out.skewDeg !== 0;
    if (rotated) {
      canvas.width = out.width;
      canvas.height = out.height;
      ctx.putImageData(new ImageData(out.data, out.width, out.height), 0, 0);

      // DO NOT scale the rotated result back down to the original footprint.
      // It was tried, purely to claw back latency (rotation expands the canvas
      // so no corner is clipped, and a 15deg skew turns 760x1090 into
      // ~1017x1250 — more image tokens, ~1-2s slower). Measured on production,
      // it moved a COMPLIANT label from `clean` to `warning_failure` on both
      // passes: rotating and then scaling resamples the text twice, and the
      // second pass blurs the warning enough to be misread. A false rejection
      // is the costliest error this tool can make; ~1s of latency is not worth
      // it. If the expansion ever needs paying back, do the scale INSIDE the
      // rotation as a single bilinear pass — never as a second resample.
    }
  } catch {
    // A tainted canvas or an OOM must not cost the user their check — fall
    // back to the plain downscale, which is what shipped before enhancement.
    rotated = false;
  }

  // Nothing to fix and nothing to shrink: return the ORIGINAL bytes rather than
  // a JPEG re-encode. Routing every upload through canvas.toBlob() would add a
  // lossy generation to labels that never needed touching — a silent quality
  // regression on the clean path, paid by every user to help a minority.
  if (!rotated && scale === 1) return file;

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.92),
  );
  if (!blob) return file;
  return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
}
