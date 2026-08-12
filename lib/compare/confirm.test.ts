import { describe, expect, it } from "vitest";
import { applySecondReading, checkWarning } from "./warning.ts";
import { CANONICAL_WARNING } from "./canonical.ts";

/** The false-rejection guard shared by /api/check (blocking, batch) and
 *  /api/confirm (async, single check). */
describe("applySecondReading", () => {
  const swapped = CANONICAL_WARNING.replace("birth", "health");
  const failing = checkWarning({ status: "found", text: swapped, boldAdvisory: "bold" });
  const advisories = { boldAdvisory: "bold" as const };

  it("upholds the failure when the second reading also deviates, and says so", () => {
    const applied = applySecondReading(failing, "warning_failure", { status: "found", text: swapped }, advisories);
    expect(applied.outcome).toBe("confirmed");
    expect(applied.warning.verdict).toBe("fail_wording");
    expect(applied.overall).toBe("warning_failure");
    expect(applied.warning.notes[0]).toBe("Confirmed by a second independent reading.");
  });

  it("downgrades to check-manually when the second reading passes (disagreement)", () => {
    const applied = applySecondReading(failing, "warning_failure", { status: "found", text: CANONICAL_WARNING }, advisories);
    expect(applied.outcome).toBe("downgraded");
    expect(applied.warning.verdict).toBe("unreadable");
    expect(applied.overall).toBe("needs_review");
    expect(applied.warning.notes[0]).toMatch(/readings.*disagree/i);
  });

  it("leaves the single-reading verdict untouched when the confirmation is unavailable", () => {
    const applied = applySecondReading(failing, "warning_failure", null, advisories);
    expect(applied.outcome).toBe("unavailable");
    expect(applied.warning).toBe(failing);
    expect(applied.overall).toBe("warning_failure");
  });

  it("does not let an unreadable second reading rescue or confirm anything", () => {
    const applied = applySecondReading(failing, "warning_failure", { status: "unreadable", text: "" }, advisories);
    expect(applied.outcome).toBe("unavailable");
    expect(applied.warning.verdict).toBe("fail_wording");
  });
});

/** Damaged-image guard (evidence: docs/degraded-hard.json). Two readings that
 *  both fail but disagree about WHICH words differ indicate a misread, not a
 *  defect — a deliberate swap reproduces, a torn corner does not. */
describe("applySecondReading — deviation agreement", () => {
  const advisories = { boldAdvisory: "bold" as const };
  const swapped = CANONICAL_WARNING.replace("birth", "health");
  const otherSwap = CANONICAL_WARNING.replace("machinery", "machinary");

  it("upholds a real word swap when both readings name the SAME word", () => {
    const first = checkWarning({ status: "found", text: swapped, boldAdvisory: "bold" });
    const applied = applySecondReading(first, "warning_failure", { status: "found", text: swapped }, advisories);
    expect(applied.outcome).toBe("confirmed");
    expect(applied.warning.verdict).toBe("fail_wording");
  });

  it("downgrades when both readings fail but disagree about which word", () => {
    const first = checkWarning({ status: "found", text: swapped, boldAdvisory: "bold" });
    const applied = applySecondReading(first, "warning_failure", { status: "found", text: otherSwap }, advisories);
    expect(applied.outcome).toBe("downgraded");
    expect(applied.warning.verdict).toBe("unreadable");
    expect(applied.overall).toBe("needs_review");
    expect(applied.warning.notes[0]).toMatch(/disagree about which words/i);
  });

  it("downgrades when the second reading is truncated (far more deviations)", () => {
    const first = checkWarning({ status: "found", text: swapped, boldAdvisory: "bold" });
    const truncated = CANONICAL_WARNING.split(" ").slice(0, 12).join(" ");
    const applied = applySecondReading(first, "warning_failure", { status: "found", text: truncated }, advisories);
    expect(applied.outcome).toBe("downgraded");
  });

  it("still rescues a clean label whose first read hallucinated a deviation", () => {
    const first = checkWarning({ status: "found", text: swapped, boldAdvisory: "bold" });
    const applied = applySecondReading(first, "warning_failure", { status: "found", text: CANONICAL_WARNING }, advisories);
    expect(applied.outcome).toBe("downgraded");
  });
});
