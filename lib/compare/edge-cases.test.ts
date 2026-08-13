import { describe, it, expect } from "vitest";
import { parseAbv } from "./abv.ts";
import { parseVolumeMl } from "./netContents.ts";
import { checkWarning } from "./warning.ts";
import { CANONICAL_WARNING } from "./canonical.ts";

/** Regression cover for the 2026-08-13 edge-case audit. Each case here is one
 *  a previous version answered confidently and wrongly. */

describe("signed numbers are refused, not silently made positive", () => {
  it("does not report -750 mL as 750 mL", () => {
    expect(parseVolumeMl("-750 mL")).toBeNull();
    expect(parseVolumeMl("750 mL")).toBe(750);
  });

  it("does not report -45% as 45%", () => {
    expect(parseAbv("-45%").percent).toBeNull();
    expect(parseAbv("45%").percent).toBe(45);
  });

  it("does not derive an ABV from negative proof", () => {
    expect(parseAbv("-90 proof").proof).toBeNull();
    expect(parseAbv("-90 proof").percent).toBeNull();
    expect(parseAbv("90 proof").percent).toBe(45);
  });

  it("still parses ordinary values, including zero", () => {
    expect(parseVolumeMl("0 mL")).toBe(0);
    expect(parseAbv("0%").percent).toBe(0);
    expect(parseVolumeMl("1,000 ml")).toBe(1000);
    expect(parseVolumeMl("75 cl")).toBe(750);
  });

  it("is not confused by a hyphen used as a separator", () => {
    // "750 mL - 25.4 fl oz" — the hyphen precedes a space, not a digit.
    expect(parseVolumeMl("750 mL - 25.4 fl oz")).toBe(750);
  });
});

describe("legibility gate", () => {
  // This is what makes the fail-open fix safe: when the typography call gives
  // us nothing we now report "marginal", so these are the verdicts that
  // default now produces.
  const found = (legibility: "crisp" | "marginal" | "illegible") =>
    checkWarning({ status: "found", text: CANONICAL_WARNING, boldAdvisory: "bold", legibility });

  it("keeps a pass when the text was legibly read", () => {
    expect(found("crisp").verdict).toMatch(/^pass/);
  });

  it("downgrades an unsupportable pass to check-manually", () => {
    expect(found("marginal").verdict).toBe("unreadable");
    expect(found("illegible").verdict).toBe("unreadable");
  });

  it("never turns a legibility problem into a failure", () => {
    // The gate may only remove confidence, never manufacture a violation.
    for (const g of ["marginal", "illegible"] as const) {
      expect(found(g).verdict.startsWith("fail")).toBe(false);
    }
  });

  it("leaves a real failure failing regardless of legibility", () => {
    const titleCase = CANONICAL_WARNING.replace("GOVERNMENT WARNING", "Government Warning");
    const r = checkWarning({ status: "found", text: titleCase, boldAdvisory: "bold", legibility: "marginal" });
    expect(r.verdict).toBe("fail_prefix_case");
  });
});
