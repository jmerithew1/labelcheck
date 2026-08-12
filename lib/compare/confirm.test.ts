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
    expect(applied.warning.notes[0]).toBe("Confirmed by a second independent AI reading.");
  });

  it("downgrades to check-manually when the second reading passes (disagreement)", () => {
    const applied = applySecondReading(failing, "warning_failure", { status: "found", text: CANONICAL_WARNING }, advisories);
    expect(applied.outcome).toBe("downgraded");
    expect(applied.warning.verdict).toBe("unreadable");
    expect(applied.overall).toBe("needs_review");
    expect(applied.warning.notes[0]).toMatch(/two independent ai readings.*disagree/i);
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
