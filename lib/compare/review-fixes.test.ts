import { describe, it, expect } from "vitest";
import { compareNetContents, parseVolumeMl } from "./netContents.ts";
import { checkWarning } from "./warning.ts";
import { CANONICAL_WARNING } from "./canonical.ts";

/** Regression tests for the final-gate review findings. */

describe("thousands separators (review finding: false 1000× match)", () => {
  it("parses '1,000 ml' as 1000 mL, not 1 mL", () => {
    expect(parseVolumeMl("1,000 ml")).toBe(1000);
  });

  it("never reports 1 mL vs 1,000 ml as a match", () => {
    const r = compareNetContents("1 mL", "1,000 ml");
    expect(r.verdict).toBe("possible_mismatch");
  });

  it("matches 1 L against 1,000 ml", () => {
    const r = compareNetContents("1 L", "1,000 ml");
    expect(["match", "match_formatting"]).toContain(r.verdict);
  });

  it("still accepts a genuine European decimal comma", () => {
    expect(parseVolumeMl("0,75 l")).toBe(750);
  });
});

describe("fl oz conversion tolerance (review finding: 750 mL vs 25.4 FL OZ flagged)", () => {
  it("accepts the customary 25.4 fl oz ≡ 750 mL equivalence", () => {
    const r = compareNetContents("750 mL", "25.4 FL. OZ.");
    expect(["match", "match_formatting"]).toContain(r.verdict);
  });

  it("still flags a real size difference (750 vs 700)", () => {
    expect(compareNetContents("750 mL", "700 mL").verdict).toBe("possible_mismatch");
  });
});

describe("bold fail-open hedge (red-team finding: non-bold prefix sailed through green)", () => {
  it("a passing warning ALWAYS carries a bold-verification note, even when AI says bold", () => {
    const r = checkWarning({ status: "found", text: CANONICAL_WARNING, boldAdvisory: "bold" });
    expect(r.verdict).toBe("pass");
    expect(r.notes.join(" ")).toMatch(/bold/i);
    expect(r.notes.join(" ")).toMatch(/confirm|verify|glance/i);
  });
});

describe("small-warning size advisory (red-team finding: shrunken warning passed silently)", () => {
  it("surfaces a size note when the extractor judges the warning small", () => {
    const r = checkWarning({
      status: "found",
      text: CANONICAL_WARNING,
      boldAdvisory: "bold",
      sizeAdvisory: "small",
    });
    expect(r.verdict).toBe("pass");
    expect(r.notes.join(" ")).toMatch(/small/i);
  });

  it("adds no size note for normal-size warnings", () => {
    const r = checkWarning({
      status: "found",
      text: CANONICAL_WARNING,
      boldAdvisory: "bold",
      sizeAdvisory: "normal",
    });
    expect(r.notes.join(" ")).not.toMatch(/unusually small/i);
  });
});
