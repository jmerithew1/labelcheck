import { describe, it, expect } from "vitest";
import type { CheckResult } from "./compare/index.ts";
import type { FieldVerdict, WarningVerdict } from "./compare/types.ts";
import { summarizeVerdict, boldStatus } from "./verdict.ts";

/** These cases are the ones a user walked into on the shipped build: the
 *  headline said one thing and the ruling the agent had just made said
 *  another. They are regression tests first and unit tests second. */

const field = (name: string, verdict: FieldVerdict): CheckResult["fields"][number] => ({
  field: name,
  verdict,
  applicationValue: "x",
  labelValue: "y",
});

const result = (
  fields: CheckResult["fields"],
  warningVerdict: WarningVerdict = "pass",
  notes: string[] = [],
): CheckResult => ({
  is_alcohol_label: true,
  fields,
  overall: "clean",
  warning: {
    verdict: warningVerdict,
    labelText: "",
    deviations: [],
    prefixAllCaps: true,
    boldAdvisory: "bold",
    bodyBoldAdvisory: "not_bold",
    notes,
  },
});

const ALL_MATCH = [field("brand_name", "match"), field("class_type", "match")];

describe("boldStatus", () => {
  it("is not applicable while the wording itself fails", () => {
    expect(boldStatus("fail_wording", { auto: null, human: null })).toBe("not_applicable");
    expect(boldStatus("unreadable", { auto: "bold", human: null })).toBe("not_applicable");
  });

  it("lets the agent outrank the measurement in both directions", () => {
    expect(boldStatus("pass", { auto: "bold", human: "flagged" })).toBe("rejected");
    expect(boldStatus("pass", { auto: "not_bold", human: "confirmed" })).toBe("accepted");
  });

  it("owes a glance only once the gate has finished and failed to resolve it", () => {
    expect(boldStatus("pass", { auto: null, human: null, measuring: true })).toBe("measuring");
    expect(boldStatus("pass", { auto: "human", human: null })).toBe("owed");
    expect(boldStatus("pass", { auto: null, human: null })).toBe("owed");
    expect(boldStatus("pass_formatting_note", { auto: "bold", human: null })).toBe("auto_verified");
  });
});

describe("summarizeVerdict", () => {
  it("calls a machine-verified clean label matched, with nothing left to do", () => {
    const s = summarizeVerdict(result(ALL_MATCH), {}, { auto: "bold", human: null });
    expect(s.tone).toBe("ok");
    expect(s.short).toBe("matched");
    expect(s.confirmCount).toBe(0);
    expect(s.issueCount).toBe(0);
  });

  it("does NOT call a label matched while a bold glance is owed", () => {
    const s = summarizeVerdict(result(ALL_MATCH), {}, { auto: "human", human: null });
    expect(s.tone).toBe("warn");
    expect(s.confirmCount).toBe(1);
    expect(s.title).toBe("1 item needs confirmation");
  });

  it("counts an owed bold glance exactly once", () => {
    const s = summarizeVerdict(result(ALL_MATCH), {}, { auto: "human", human: null });
    // The banner used to show "1 review" AND "1 to confirm (bold)" for the
    // same single outstanding item.
    expect(s.chips.filter((c) => /confirm|review/.test(c.text))).toHaveLength(1);
  });

  it("treats a REJECTED bold type as a failure, not as work outstanding", () => {
    const s = summarizeVerdict(result(ALL_MATCH), {}, { auto: "human", human: "flagged" });
    expect(s.tone).toBe("bad");
    expect(s.issueCount).toBe(1);
    expect(s.confirmCount).toBe(0);
    expect(s.title).toBe("Government warning fails");
    expect(s.short).toBe("bold rejected");
    expect(s.sub).toMatch(/rejected the bold type/i);
  });

  it("still fails when the agent rejects bold the measurement had verified", () => {
    // The bug as reported: gate says bold, agent disagrees, headline said
    // "Label matches the application".
    const s = summarizeVerdict(result(ALL_MATCH), {}, { auto: "bold", human: "flagged" });
    expect(s.tone).toBe("bad");
    expect(s.title).toBe("Government warning fails");
  });

  it("names the government warning even when fields are also mismatched", () => {
    const s = summarizeVerdict(
      result([...ALL_MATCH, field("alcohol_content", "possible_mismatch")], "fail_prefix_case"),
      {},
      { auto: null, human: null },
    );
    expect(s.tone).toBe("bad");
    expect(s.issueCount).toBe(2);
    expect(s.sub).toMatch(/warning statement/i);
    expect(s.sub).toMatch(/1 field does not match/i);
  });

  it("resolves to matched once every flagged field is accepted", () => {
    const r = result([...ALL_MATCH, field("alcohol_content", "possible_mismatch")]);
    const s = summarizeVerdict(r, { alcohol_content: "accepted" }, { auto: "bold", human: null });
    expect(s.tone).toBe("ok");
    expect(s.accepted).toBe(1);
    expect(s.mismatch).toBe(0);
    expect(s.chips.some((c) => c.text === "1 accepted by you")).toBe(true);
  });

  it("keeps a rejected field red", () => {
    const r = result([...ALL_MATCH, field("alcohol_content", "possible_mismatch")]);
    const s = summarizeVerdict(r, { alcohol_content: "confirmed" }, { auto: "bold", human: null });
    expect(s.tone).toBe("bad");
    expect(s.mismatch).toBe(1);
    expect(s.short).toBe("1 mismatch");
  });

  it("says it is still checking rather than asking for a confirmation it may resolve", () => {
    const s = summarizeVerdict(result(ALL_MATCH), {}, { auto: null, human: null, measuring: true });
    expect(s.tone).toBe("ok");
    expect(s.bold).toBe("measuring");
    expect(s.sub).toMatch(/measuring the bold type/i);
  });

  it("counts an unreadable field as confirmation work, not as a failure", () => {
    const s = summarizeVerdict(
      result([...ALL_MATCH, field("net_contents", "unreadable")]),
      {},
      { auto: "bold", human: null },
    );
    expect(s.tone).toBe("warn");
    expect(s.review).toBe(1);
    expect(s.short).toBe("1 to confirm");
  });
});

describe("provisional warning failures", () => {
  /** Measured on 10 real approved TTB labels through the shipped async path:
   *  4 returned `fail_wording` on the first reading and were downgraded to
   *  review by the background second reading. The headline must not assert a
   *  failure it is about to withdraw. */
  it("does not assert a failure while the second reading is still running", () => {
    const s = summarizeVerdict(result(ALL_MATCH, "fail_wording"), {}, { auto: null, human: null }, true);
    expect(s.tone).toBe("warn");
    expect(s.short).toBe("double-checking…");
    expect(s.title).toMatch(/double-check/i);
    expect(s.chips.some((c) => c.text === "warning fails")).toBe(false);
  });

  it("asserts it the moment the second reading has landed", () => {
    const s = summarizeVerdict(result(ALL_MATCH, "fail_wording"), {}, { auto: null, human: null }, false);
    expect(s.tone).toBe("bad");
    expect(s.title).toBe("Government warning fails");
    expect(s.chips.some((c) => c.text === "warning fails")).toBe(true);
  });

  it("leaves a field mismatch alone — only the warning is provisional", () => {
    const s = summarizeVerdict(
      result([...ALL_MATCH, field("alcohol_content", "possible_mismatch")]),
      {},
      { auto: "bold", human: null },
      true,
    );
    expect(s.tone).toBe("bad");
    expect(s.short).toBe("1 mismatch");
  });
});
