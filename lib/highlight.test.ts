// @vitest-environment node
import { describe, it, expect } from "vitest";
import { matchExact, matchBlock, type OcrIndex, type OcrWord } from "./highlight.ts";

/** The click-to-highlight geometry had one real shipped bug — a token shared
 *  with another field dragged the box across lines ("Distilled Gin" matched
 *  the GIN in "HARBOR LIGHT GIN" plus the DISTILLED two lines below, and the
 *  highlight spanned the gap). These tests pin the line-scoped matcher that
 *  fixed it, using a synthetic label laid out like the one that failed. */

const word = (text: string, x0: number, y0: number, x1: number, y1: number, line: number): OcrWord =>
  ({ text, x0, y0, x1, y1, line });

/** A 1000×1000 label with the gin layout: brand on line 0, class two lines
 *  down, an ABV line, and a three-line warning block. */
const ginLabel = (): OcrIndex => {
  const words = [
    word("HARBOR", 100, 100, 260, 140, 0), word("LIGHT", 270, 100, 390, 140, 0), word("GIN", 400, 100, 480, 140, 0),
    word("Est.", 100, 160, 150, 180, 1), word("2019", 160, 160, 230, 180, 1),
    word("DISTILLED", 100, 220, 300, 260, 2), word("GIN", 310, 220, 390, 260, 2),
    word("47%", 100, 300, 170, 330, 3), word("ALC./VOL.", 180, 300, 340, 330, 3),
    word("GOVERNMENT", 100, 700, 320, 730, 4), word("WARNING:", 330, 700, 500, 730, 4),
    word("ACCORDING", 510, 700, 690, 730, 4), word("TO", 700, 700, 740, 730, 4),
    word("THE", 100, 740, 160, 770, 5), word("SURGEON", 170, 740, 330, 770, 5), word("GENERAL", 340, 740, 500, 770, 5),
    word("WOMEN", 510, 740, 640, 770, 5), word("SHOULD", 650, 740, 780, 770, 5),
    word("NOT", 100, 780, 170, 810, 6), word("DRINK", 180, 780, 300, 810, 6), word("ALCOHOLIC", 310, 780, 500, 810, 6),
    word("BEVERAGES", 510, 780, 700, 810, 6),
  ];
  const byLine = new Map<number, OcrWord[]>();
  for (const w of words) byLine.set(w.line, [...(byLine.get(w.line) ?? []), w]);
  const lines = [...byLine.entries()].map(([line, ws]) => ({
    text: ws.map((w) => w.text).join(" "),
    x0: Math.min(...ws.map((w) => w.x0)), y0: Math.min(...ws.map((w) => w.y0)),
    x1: Math.max(...ws.map((w) => w.x1)), y1: Math.max(...ws.map((w) => w.y1)),
    line,
  }));
  return { words, lines, width: 1000, height: 1000 };
};

describe("matchExact — the line-scoped matcher", () => {
  it("keeps 'Distilled Gin' on its own line instead of spanning to the brand's GIN (the shipped bug)", () => {
    const r = matchExact(ginLabel(), "Distilled Gin")!;
    expect(r).not.toBeNull();
    // Line 2 sits at y 220–260 of 1000 → the box must stay in that band,
    // not stretch up to the brand line at y=100.
    expect(r.top).toBeGreaterThan(15);
    expect(r.top + r.height).toBeLessThan(32);
  });

  it("finds the brand line even though it shares GIN with the class line", () => {
    const r = matchExact(ginLabel(), "HARBOR LIGHT GIN")!;
    expect(r).not.toBeNull();
    expect(r.top).toBeLessThan(12); // brand line at y=100
    expect(r.top + r.height).toBeLessThan(18); // and does not extend down
  });

  it("tolerates one OCR-mangled token (a decorative word must not force the band fallback)", () => {
    const idx = ginLabel();
    // OCR read HARBOR as something unusable.
    idx.words[0] = { ...idx.words[0], text: "H@RB0R" };
    const r = matchExact(idx, "HARBOR LIGHT GIN");
    expect(r).not.toBeNull(); // 2 of 3 tokens ≥ the 60% threshold
  });

  it("returns null rather than guessing when the text simply is not there", () => {
    expect(matchExact(ginLabel(), "SILVER BIRCH VODKA")).toBeNull();
  });

  it("returns null for a target with no usable tokens", () => {
    expect(matchExact(ginLabel(), "—  !")).toBeNull();
  });

  it("normalizes against image dimensions, not text extents (the original coordinate bug)", () => {
    const r = matchExact(ginLabel(), "47% ALC./VOL.")!;
    // Words span x 100–340 of 1000 → left ≈ 10%, right edge ≈ 34%. If it
    // normalized against the text block instead, left would be ~0.
    expect(r.left).toBeGreaterThan(8);
    expect(r.left).toBeLessThan(11);
    expect(r.left + r.width).toBeLessThan(37);
  });
});

describe("matchBlock — the multi-line warning", () => {
  it("unions exactly the warning lines, not the label above them", () => {
    const target =
      "GOVERNMENT WARNING: ACCORDING TO THE SURGEON GENERAL WOMEN SHOULD NOT DRINK ALCOHOLIC BEVERAGES";
    const r = matchBlock(ginLabel(), target)!;
    expect(r).not.toBeNull();
    // Warning block spans y 700–810 of 1000.
    expect(r.top).toBeGreaterThan(65);
    expect(r.top + r.height).toBeLessThan(86);
  });

  it("ignores short lines and lines that only graze the target", () => {
    const r = matchBlock(ginLabel(), "GOVERNMENT WARNING: ACCORDING TO THE SURGEON GENERAL");
    // Only the true warning lines qualify on ≥50% token overlap; the ABV and
    // brand lines must not be swept in.
    expect(r).not.toBeNull();
    expect(r!.top).toBeGreaterThan(65);
  });

  it("returns null when nothing overlaps", () => {
    expect(matchBlock(ginLabel(), "COMPLETELY UNRELATED TEXT NOWHERE PRESENT")).toBeNull();
  });
});
