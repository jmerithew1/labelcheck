/**
 * What the BYTES say a file is, regardless of what its name claims.
 *
 * The browser derives a File's `type` from its extension, so a GIF renamed
 * .png arrives declaring image/png and passes a MIME allowlist untouched. It
 * then dies upstream at the model, and the user gets "Something went wrong —
 * try again", which is both wrong and unactionable: retrying the same bytes
 * fails forever. Reading the first few bytes lets the upload be rejected with
 * a sentence that says what is actually wrong.
 *
 * Deliberately small: it recognises the formats we accept plus the few
 * look-alikes people actually mis-name. Anything unrecognised returns null and
 * the caller lets it through — a sniffer that guesses would reject valid
 * files, which is a worse failure than the one it prevents.
 */

export type SniffedType = "image/png" | "image/jpeg" | "image/webp" | "application/pdf" | "image/gif" | "image/bmp" | "image/tiff";

const startsWith = (b: Uint8Array, sig: number[], offset = 0) =>
  sig.every((v, i) => b[offset + i] === v);

/** Identify a file from its leading bytes; null when unrecognised. */
export function sniffType(bytes: Uint8Array): SniffedType | null {
  if (bytes.length < 12) return null;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // RIFF....WEBP
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return "application/pdf";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp";
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff";
  return null;
}

const FRIENDLY: Record<SniffedType, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
  "application/pdf": "PDF",
  "image/gif": "GIF",
  "image/bmp": "BMP",
  "image/tiff": "TIFF",
};

/**
 * null = accept. A string = the reason to reject, written for someone who did
 * not choose the file's extension on purpose.
 */
export function fileTypeComplaint(
  bytes: Uint8Array,
  declared: string,
  filename: string,
): string | null {
  const actual = sniffType(bytes);
  if (!actual) {
    // Unreadable header on something claiming to be an image is a truncated
    // or corrupt file — the one case worth rejecting without a positive ID,
    // because it cannot possibly decode downstream.
    return `"${filename}" isn't a readable image file — it may be corrupt or incompletely uploaded. Try saving it again, or export a fresh copy.`;
  }
  if (actual === declared) return null;
  const supported = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);
  if (supported.has(actual)) return null; // right family, wrong extension — harmless
  return `"${filename}" is really a ${FRIENDLY[actual]} file with the wrong extension. Save or export it as a PNG, JPEG, or WebP and upload it again.`;
}
