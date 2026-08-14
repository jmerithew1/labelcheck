import { describe, it, expect } from "vitest";
import type { CheckResult } from "./compare/index.ts";
import type { FieldVerdict, WarningVerdict } from "./compare/types.ts";
import { bucketOf, boldEligible, boldPendingRow, type TriageRow } from "./batchTriage.ts";

/** These pin the batch triage rules after the process was unified with the
 *  single check. The regression that motivated them: with the bold pass
 *  opt-in past 60 rows, a 250-label batch opened with all 250 rows in Needs
 *  review — a wall of amber that triaged nothing. The bucket rules now
 *  distinguish "the machine found a problem" (review) from "the measurement
 *  is still running on a clean row" (bold_checking) from "finished"
 *  (matched), and these cases hold each boundary in place. */

const field = (name: string, verdict: FieldVerdict): CheckResult["fields"][number] => ({
  field: name,
  verdict,
  applicationValue: "x",
  labelValue: "y",
});

const result = (
  overall: CheckResult["overall"],
  fields: CheckResult["fields"],
  warningVerdict: WarningVerdict = "pass",
): CheckResult => ({
  is_alcohol_label: true,
  fields,
  overall,
  warning: {
    verdict: warningVerdict,
    labelText: "",
    deviations: [],
    prefixAllCaps: true,
    boldAdvisory: "bold",
    bodyBoldAdvisory: "not_bold",
    notes: [],
  },
});

const row = (r: Partial<TriageRow>): TriageRow => ({ status: "done", ...r });

const CLEAN = result("clean", [field("brand_name", "match")]);
const MISMATCH = result("needs_review", [field("brand_name", "possible_mismatch")]);
const WARN_FAIL = result("warning_failure", [field("brand_name", "match")], "fail_wording");

describe("bucketOf — the bold_checking bucket", () => {
  it("clean row still being measured is bold_checking, not review and not matched", () => {
    expect(bucketOf(row({ result: CLEAN, boldAuto: undefined }))).toBe("bold_checking");
  });

  it("a row with a field mismatch stays review while its bold is measured — bold is not why it needs attention", () => {
    expect(bucketOf(row({ result: MISMATCH, boldAuto: undefined }))).toBe("review");
  });

  it("a warning failure is never bold_checking — the warning failed, so the row is not bold-eligible", () => {
    expect(bucketOf(row({ result: WARN_FAIL, boldAuto: undefined }))).toBe("review");
    expect(boldEligible(row({ result: WARN_FAIL }))).toBe(false);
  });

  it("measurement resolving to confident-bold moves the row to matched — green means finished", () => {
    expect(bucketOf(row({ result: CLEAN, boldAuto: "bold" }))).toBe("matched");
  });

  it("measurement resolving to inconclusive moves the row to review — the glance is genuinely owed now", () => {
    expect(bucketOf(row({ result: CLEAN, boldAuto: "human" }))).toBe("review");
    expect(boldPendingRow(row({ result: CLEAN, boldAuto: "human" }))).toBe(true);
  });

  it("measurement resolving to confident-not-bold escalates to review", () => {
    expect(bucketOf(row({ result: CLEAN, boldAuto: "not_bold" }))).toBe("review");
  });

  it("a row still being measured is NOT counted as owing a glance — the dot, chip and strip must describe the same set", () => {
    expect(boldPendingRow(row({ result: CLEAN, boldAuto: undefined }))).toBe(false);
  });
});

describe("bucketOf — human rulings outrank everything, including the measuring state", () => {
  it("Accept label wins over an in-flight measurement", () => {
    expect(bucketOf(row({ result: CLEAN, boldAuto: undefined, agentReview: "ok" }))).toBe("matched");
  });

  it("Reject label wins over an in-flight measurement", () => {
    expect(bucketOf(row({ result: CLEAN, boldAuto: undefined, agentReview: "correction" }))).toBe("review");
  });

  it("a human bold decision settles the row without waiting for the machine", () => {
    expect(bucketOf(row({ result: CLEAN, boldAuto: undefined, boldReview: "confirmed" }))).toBe("matched");
    expect(bucketOf(row({ result: CLEAN, boldAuto: undefined, boldReview: "flagged" }))).toBe("review");
  });

  it("a human confirm overrides a machine not-bold", () => {
    expect(bucketOf(row({ result: CLEAN, boldAuto: "not_bold", boldReview: "confirmed" }))).toBe("matched");
  });
});

describe("bucketOf — the states around the new bucket are unchanged", () => {
  it("errors and pending rows keep their buckets", () => {
    expect(bucketOf(row({ status: "error" }))).toBe("error");
    expect(bucketOf(row({ status: "checking" }))).toBe("pending");
    expect(bucketOf(row({ status: "queued" }))).toBe("pending");
  });

  it("a clean row whose fields were all not_provided is not_required once bold resolves", () => {
    const noFields = result("clean", [field("brand_name", "not_provided")]);
    expect(bucketOf(row({ result: noFields, boldAuto: "bold" }))).toBe("not_required");
  });

  it("accepting every flagged field resolves the row like a clean one (bold measured) or keeps it bold_checking (still measuring)", () => {
    const accepted = { fieldReview: { brand_name: "accepted" as const } };
    expect(bucketOf(row({ result: MISMATCH, boldAuto: "bold", ...accepted }))).toBe("matched");
    expect(bucketOf(row({ result: MISMATCH, boldAuto: undefined, ...accepted }))).toBe("bold_checking");
  });
});
