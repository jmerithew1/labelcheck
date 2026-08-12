import { describe, it, expect } from "vitest";
import { CANONICAL_WARNING, WARNING_PREFIX } from "./canonical.ts";
import { checkWarning } from "./warning.ts";
import { compareAbv } from "./abv.ts";
import { compareNetContents, parseVolumeMl } from "./netContents.ts";
import { compareTextField, normalizeLoose, similarity } from "./fields.ts";
import { compareLabel, type ApplicationData } from "./index.ts";
import type { LabelExtraction } from "../vision/contract.ts";

// Gap tests: edge cases the main suite does not pin down. Each asserts
// behavior that, if it regressed, would change a verdict shown to an agent.

const found = (text: string) => ({ status: "found" as const, text });
const absent = { status: "absent" as const, text: "" };
const unreadable = { status: "unreadable" as const, text: "" };

// ---------- warning: prefix position and adversarial prefixes ----------

describe("warning gaps", () => {
  it("fails when extra text precedes the warning (prefix must be at the start, not mid-text)", () => {
    const r = checkWarning({
      status: "found",
      text: "Enjoy responsibly. " + CANONICAL_WARNING,
      boldAdvisory: "bold",
    });
    expect(r.verdict).toBe("fail_wording");
    expect(r.deviations.some((d) => d.kind === "added")).toBe(true);
  });

  it("fails a mixed-case prefix (GOVERNMENT Warning:) as a case failure, not a pass", () => {
    const r = checkWarning({
      status: "found",
      text: CANONICAL_WARNING.replace("GOVERNMENT WARNING:", "GOVERNMENT Warning:"),
      boldAdvisory: "bold",
    });
    expect(r.verdict).toBe("fail_prefix_case");
  });

  it("fails an all-lowercase prefix", () => {
    const r = checkWarning({
      status: "found",
      text: CANONICAL_WARNING.replace("GOVERNMENT WARNING:", "government warning:"),
      boldAdvisory: "bold",
    });
    expect(r.verdict).toBe("fail_prefix_case");
  });

  it("fails a dropped colon as a wording deviation (the colon is mandatory text)", () => {
    const r = checkWarning({
      status: "found",
      text: CANONICAL_WARNING.replace("WARNING:", "WARNING"),
      boldAdvisory: "bold",
    });
    expect(r.verdict).toBe("fail_wording");
  });

  it('fails an abbreviated prefix ("GOVT WARNING:") as wording, never a pass', () => {
    const r = checkWarning({
      status: "found",
      text: CANONICAL_WARNING.replace("GOVERNMENT", "GOVT"),
      boldAdvisory: "bold",
    });
    expect(r.verdict).toBe("fail_wording");
  });

  it("fails loudly on status=found with empty text (never a silent pass)", () => {
    // Post-review behavior: an empty "found" transcription is a contradiction
    // from the extractor — reported as missing, not diffed against "".
    const r = checkWarning({ status: "found", text: "", boldAdvisory: "bold" });
    expect(r.verdict).toBe("fail_missing");
  });

  it("surfaces an 'unclear' bold advisory as a note without failing the text check", () => {
    const r = checkWarning({ status: "found", text: CANONICAL_WARNING, boldAdvisory: "unclear" });
    expect(r.verdict).toBe("pass");
    expect(r.notes.join(" ")).toContain("bold");
  });

  it("keeps the canonical constant itself intact (checks against tampering/typos)", () => {
    // Character-for-character invariants of 27 CFR 16.21 the comparisons rely on.
    expect(CANONICAL_WARNING.startsWith("GOVERNMENT WARNING: (1) According to the Surgeon General,")).toBe(true);
    expect(CANONICAL_WARNING).toContain("machinery, and may cause health problems.");
    expect(CANONICAL_WARNING).not.toContain("General's"); // no apostrophe-s
    expect(WARNING_PREFIX).toBe("GOVERNMENT WARNING");
  });
});

// ---------- ABV / net contents: parse failure and unit edges ----------

describe("numeric field gaps", () => {
  it("degrades to manual-compare on an empty label ABV string", () => {
    expect(compareAbv("45%", "").verdict).toBe("possible_mismatch");
  });

  it("matches a proof-only label statement against a percent application (proof = 2x ABV)", () => {
    const r = compareAbv("45%", "90 Proof");
    expect(["match", "match_formatting"]).toContain(r.verdict);
  });

  it("parses unit variants: no-space '75cl', British spellings, fl oz", () => {
    expect(parseVolumeMl("75cl")).toBe(750);
    expect(parseVolumeMl("1 litre")).toBe(1000);
    expect(parseVolumeMl("750 millilitres")).toBe(750);
    expect(parseVolumeMl("12 fl. oz.")).toBeCloseTo(354.88, 1);
  });

  it("returns null (manual compare), not a guess, for a bare number with no unit", () => {
    expect(parseVolumeMl("750")).toBeNull();
    expect(compareNetContents("750 mL", "750").verdict).toBe("possible_mismatch");
  });

  it("flags close-but-different volumes (750 vs 700) instead of tolerating them", () => {
    expect(compareNetContents("75 cl", "700 mL").verdict).toBe("possible_mismatch");
  });
});

// ---------- fuzzy fields: empty/degenerate inputs ----------

describe("fuzzy field gaps", () => {
  it("treats status=found with empty text as a 0-similarity mismatch, not a match", () => {
    const r = compareTextField("brand_name", "Stone's Throw", found(""));
    expect(r.verdict).toBe("possible_mismatch");
    expect(r.similarity).toBe(0);
  });

  it("normalizeLoose folds case, punctuation, diacritics, and whitespace only", () => {
    expect(normalizeLoose("STONE'S  THROW")).toBe(normalizeLoose("Stone’s Throw"));
    expect(normalizeLoose("Château Léoube")).toBe("chateau leoube");
    expect(normalizeLoose("A—B")).toBe(normalizeLoose("a b").replace(" ", "")); // punctuation stripped, not spaced
  });

  it("similarity is symmetric-ish and bounded for empty inputs", () => {
    expect(similarity("", "")).toBe(1);
    expect(similarity("abc", "")).toBe(0);
    expect(similarity("", "abc")).toBe(0);
  });
});

// ---------- compareLabel: numeric-field status wrapping and triage ----------

const app: ApplicationData = {
  brand_name: "OLD TOM DISTILLERY",
  class_type: "Kentucky Straight Bourbon Whiskey",
  alcohol_content: "45% Alc./Vol. (90 Proof)",
  net_contents: "750 mL",
};

function cleanExtraction(): LabelExtraction {
  return {
    is_alcohol_label: true,
    brand_name: found("OLD TOM DISTILLERY"),
    class_type: found("Kentucky Straight Bourbon Whiskey"),
    alcohol_content: found("45% Alc./Vol. (90 Proof)"),
    net_contents: found("750 mL"),
    bottler_name_address: absent,
    country_of_origin: absent,
    warning: found(CANONICAL_WARNING),
    warning_prefix_bold: "bold",
    warning_body_bold: "not_bold",
    warning_text_size: "normal",
  };
}

describe("compareLabel gaps (wrapNumeric paths and triage)", () => {
  it("an unreadable alcohol_content is reported unreadable and triaged needs_review, never rejected", () => {
    const ex = cleanExtraction();
    ex.alcohol_content = unreadable;
    const r = compareLabel(app, ex);
    expect(r.fields.find((f) => f.field === "alcohol_content")?.verdict).toBe("unreadable");
    expect(r.overall).toBe("needs_review");
  });

  it("an absent net_contents is absent_on_label and triaged needs_review", () => {
    const ex = cleanExtraction();
    ex.net_contents = absent;
    const r = compareLabel(app, ex);
    expect(r.fields.find((f) => f.field === "net_contents")?.verdict).toBe("absent_on_label");
    expect(r.overall).toBe("needs_review");
  });

  it("an 'unclear' bold prefix triages to needs_review even with perfect text", () => {
    const ex = cleanExtraction();
    ex.warning_prefix_bold = "unclear";
    expect(compareLabel(app, ex).overall).toBe("needs_review");
  });

  it("an unreadable warning triages to needs_review, not warning_failure", () => {
    const ex = cleanExtraction();
    ex.warning = { status: "unreadable", text: "" };
    ex.warning_prefix_bold = "unclear";
    const r = compareLabel(app, ex);
    expect(r.warning.verdict).toBe("unreadable");
    expect(r.overall).toBe("needs_review");
  });

  it("warning failures outrank field mismatches in triage", () => {
    const ex = cleanExtraction();
    ex.brand_name = found("OLD CROW DISTILLERY");
    ex.warning = absent;
    ex.warning_prefix_bold = "unclear";
    expect(compareLabel(app, ex).overall).toBe("warning_failure");
  });

  it("the not-a-label guard outranks everything, including a missing warning", () => {
    const ex = cleanExtraction();
    ex.is_alcohol_label = false;
    ex.warning = absent;
    expect(compareLabel(app, ex).overall).toBe("not_a_label");
  });
});

/** 27 CFR 16.22(a) requires the prefix bold AND the remainder NOT bold.
 *  Advisory like the prefix judgment: it routes the row to review, never
 *  asserts a failure on a visual call. */
describe("body-not-bold advisory (27 CFR 16.22(a))", () => {
  const base = { status: "found" as const, text: CANONICAL_WARNING, boldAdvisory: "bold" as const };

  it("notes a bold body without failing the warning", () => {
    const r = checkWarning({ ...base, bodyBoldAdvisory: "bold" });
    expect(r.verdict).toBe("pass");
    expect(r.bodyBoldAdvisory).toBe("bold");
    expect(r.notes.some((n) => /body text appears to be in BOLD/i.test(n))).toBe(true);
    expect(r.notes.some((n) => /16\.22\(a\)/.test(n))).toBe(true);
  });

  it("says nothing when the body is regular or unclear", () => {
    for (const v of ["not_bold", "unclear"] as const) {
      const r = checkWarning({ ...base, bodyBoldAdvisory: v });
      expect(r.notes.some((n) => /body text appears to be in BOLD/i.test(n))).toBe(false);
    }
  });

  it("routes the label to review rather than clean", () => {
    const ex = { ...cleanExtraction(), warning_body_bold: "bold" as const };
    expect(compareLabel(app, ex).overall).toBe("needs_review");
    expect(compareLabel(app, cleanExtraction()).overall).toBe("clean");
  });
});
