import { describe, it, expect } from "vitest";
import { sniffType, fileTypeComplaint } from "./fileType.ts";

/** Regression cover for the edge-case finding: a mislabeled or truncated
 *  image passed the MIME allowlist, spent a paid call, and came back as
 *  "Something went wrong — try again", which retrying can never fix. */

const bytes = (...vals: number[]) => {
  const b = new Uint8Array(16);
  vals.forEach((v, i) => (b[i] = v));
  return b;
};

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const GIF = bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d);
const BMP = bytes(0x42, 0x4d, 0x36);
const WEBP = (() => {
  const b = new Uint8Array(16);
  [0x52, 0x49, 0x46, 0x46].forEach((v, i) => (b[i] = v));
  [0x57, 0x45, 0x42, 0x50].forEach((v, i) => (b[8 + i] = v));
  return b;
})();

describe("sniffType", () => {
  it("identifies the formats the app accepts", () => {
    expect(sniffType(PNG)).toBe("image/png");
    expect(sniffType(JPEG)).toBe("image/jpeg");
    expect(sniffType(WEBP)).toBe("image/webp");
    expect(sniffType(PDF)).toBe("application/pdf");
  });

  it("identifies the look-alikes people mis-name", () => {
    expect(sniffType(GIF)).toBe("image/gif");
    expect(sniffType(BMP)).toBe("image/bmp");
  });

  it("returns null for garbage and for too-short input", () => {
    expect(sniffType(bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12))).toBeNull();
    expect(sniffType(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe("fileTypeComplaint", () => {
  it("accepts a file whose bytes match its declared type", () => {
    expect(fileTypeComplaint(PNG, "image/png", "label.png")).toBeNull();
    expect(fileTypeComplaint(PDF, "application/pdf", "label.pdf")).toBeNull();
  });

  it("names the real format when an extension lies", () => {
    const msg = fileTypeComplaint(GIF, "image/png", "label.png");
    expect(msg).toContain("GIF");
    expect(msg).toContain("label.png");
  });

  it("calls a truncated or corrupt file what it is", () => {
    const msg = fileTypeComplaint(bytes(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), "image/png", "broken.png");
    expect(msg).toMatch(/corrupt|readable/i);
  });

  it("lets a supported format through under the wrong extension", () => {
    // Really a JPEG named .png: it decodes fine, so rejecting would be worse
    // than the mismatch it reports.
    expect(fileTypeComplaint(JPEG, "image/png", "photo.png")).toBeNull();
  });

  it("never complains in a way that blames the user for the file's contents", () => {
    const msg = fileTypeComplaint(BMP, "image/png", "x.png") ?? "";
    expect(msg).toMatch(/Save or export/);
  });
});
