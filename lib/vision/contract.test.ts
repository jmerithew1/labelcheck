import { describe, it, expect } from "vitest";
import { toLabelExtraction } from "./contract.ts";

/** The model fills this schema, and a model can return anything. These cover
 *  the audit finding that enums were cast rather than validated, so a
 *  hallucinated status satisfied the compiler and then matched none of the
 *  tri-state branches downstream. */

const flat = (over: Record<string, unknown> = {}) => ({
  is_alcohol_label: true,
  brand_name_status: "found",
  brand_name_text: "OLD TOM",
  warning_status: "found",
  warning_text: "GOVERNMENT WARNING: ...",
  ...over,
});

describe("field status validation", () => {
  it("keeps the three legitimate states", () => {
    for (const s of ["found", "absent", "unreadable"] as const) {
      const text = s === "found" ? "X" : "";
      expect(toLabelExtraction(flat({ brand_name_status: s, brand_name_text: text })).brand_name.status).toBe(s);
    }
  });

  it("sends an unrecognised status to unreadable, not through as-is", () => {
    // "FOUND" (wrong case) used to pass the cast and then match no branch.
    for (const bad of ["FOUND", "Found", "missing", "", 7, null, undefined]) {
      expect(toLabelExtraction(flat({ brand_name_status: bad })).brand_name.status).toBe("unreadable");
    }
  });

  it("treats 'found' with no text as unreadable rather than comparing an empty string", () => {
    const r = toLabelExtraction(flat({ brand_name_status: "found", brand_name_text: "   " }));
    expect(r.brand_name.status).toBe("unreadable");
    expect(r.brand_name.text).toBe("");
  });

  it("coerces a non-string transcription to empty", () => {
    expect(toLabelExtraction(flat({ brand_name_text: 42 })).brand_name.text).toBe("");
  });
});

describe("advisory enums fall back to the safe end", () => {
  it("defaults bold judgments to unclear", () => {
    expect(toLabelExtraction(flat()).warning_prefix_bold).toBe("unclear");
    expect(toLabelExtraction(flat({ warning_prefix_bold: "heavier" })).warning_prefix_bold).toBe("unclear");
    expect(toLabelExtraction(flat({ warning_prefix_bold: "bold" })).warning_prefix_bold).toBe("bold");
  });

  it("defaults legibility to marginal, never to crisp", () => {
    // A claim of "crisp" must be earned; an unparseable answer has not.
    expect(toLabelExtraction(flat()).warning_legibility).toBe("marginal");
    expect(toLabelExtraction(flat({ warning_legibility: "nonsense" })).warning_legibility).toBe("marginal");
    expect(toLabelExtraction(flat({ warning_legibility: "crisp" })).warning_legibility).toBe("crisp");
  });

  it("defaults text size to normal so a bad value cannot invent a size warning", () => {
    expect(toLabelExtraction(flat({ warning_text_size: "tiny" })).warning_text_size).toBe("normal");
    expect(toLabelExtraction(flat({ warning_text_size: "small" })).warning_text_size).toBe("small");
  });
});

describe("is_alcohol_label", () => {
  it("is strictly boolean", () => {
    expect(toLabelExtraction(flat({ is_alcohol_label: "yes" })).is_alcohol_label).toBe(true);
    expect(toLabelExtraction(flat({ is_alcohol_label: undefined })).is_alcohol_label).toBe(false);
  });
});
