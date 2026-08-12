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
  // BEHAVIOUR CHANGE (evidence: docs/real-labels.json). This used to be a
  // fail_wording. Real approved labels showed the reader over-capturing
  // neighbouring blocks on crowded artwork — 6 of 196 — which is
  // indistinguishable from the label printing text beside the warning. An
  // uncorroborated cause cannot justify rejecting a compliant application, so
  // the wording is now compared on the statement alone and the adjacency is
  // raised for a human instead.
  it("raises adjacent text for review rather than failing the wording", () => {
    const r = checkWarning({
      status: "found",
      text: "Enjoy responsibly. " + CANONICAL_WARNING,
      boldAdvisory: "bold",
    });
    expect(r.verdict.startsWith("fail")).toBe(false);
    expect(r.notes.some((n) => /separate and apart/i.test(n))).toBe(true);
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
    warning_legibility: "crisp",
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

/** Legibility gate (evidence: docs/robustness-matrix.json). A word-for-word
 *  PASS asserts character-level equality; on a blurred or tiny warning the
 *  reader reconstructs the familiar sentence and a real alteration slides
 *  through. An unsupportable pass becomes "check manually" — and the gate can
 *  never manufacture a failure. */
describe("legibility gates the word-for-word claim", () => {
  const exact = { status: "found" as const, text: CANONICAL_WARNING, boldAdvisory: "bold" as const };

  it("passes when the warning is crisp", () => {
    expect(checkWarning({ ...exact, legibility: "crisp" }).verdict).toBe("pass");
    expect(checkWarning(exact).verdict).toBe("pass"); // absent signal = crisp
  });

  it("downgrades an exact-looking pass to check-manually when marginal or illegible", () => {
    for (const g of ["marginal", "illegible"] as const) {
      const r = checkWarning({ ...exact, legibility: g });
      expect(r.verdict).toBe("unreadable");
      expect(r.notes[0]).toMatch(/legible|too blurred/i);
    }
  });

  it("never turns a legibility problem into a failure", () => {
    const r = checkWarning({ ...exact, legibility: "illegible" });
    expect(r.verdict.startsWith("fail")).toBe(false);
  });

  it("leaves a genuine wording failure failing, whatever the legibility", () => {
    const swapped = CANONICAL_WARNING.replace("birth", "health");
    for (const g of ["crisp", "marginal", "illegible"] as const) {
      expect(checkWarning({ status: "found", text: swapped, boldAdvisory: "bold", legibility: g }).verdict).toBe("fail_wording");
    }
  });

  it("routes a marginal label to review, not clean", () => {
    const ex = { ...cleanExtraction(), warning_legibility: "marginal" as const };
    expect(compareLabel(app, ex).overall).toBe("needs_review");
  });
});

/** A disputed absence is not a rejection. The transcription pass can report
 *  "absent" on a warning that is merely too degraded to read; the typography
 *  pass, on the same pixels, reports illegible. Two readings disagreeing about
 *  whether a warning EXISTS is a manual check. */
describe("legibility gates the missing-warning claim", () => {
  const absent = { status: "absent" as const, text: "", boldAdvisory: "unclear" as const };

  it("still fails a genuinely missing warning on a legible image", () => {
    expect(checkWarning({ ...absent, legibility: "crisp" }).verdict).toBe("fail_missing");
    expect(checkWarning(absent).verdict).toBe("fail_missing");
  });

  it("downgrades a disputed absence to check-manually", () => {
    for (const g of ["marginal", "illegible"] as const) {
      const r = checkWarning({ ...absent, legibility: g });
      expect(r.verdict).toBe("unreadable");
      expect(r.notes[0]).toMatch(/too degraded/i);
    }
  });
});

/** Spacing is typography, not wording. Real approved TTB labels routinely
 *  print "(1)According" and "defects.(2)" with no space — 12 of 14 sampled
 *  wording failures on the real corpus were this and nothing else. Removing
 *  whitespace before comparing cannot mask a genuine defect. */
describe("missing whitespace is a formatting note, not a wording failure", () => {
  const bold = { boldAdvisory: "bold" as const, legibility: "crisp" as const };
  const squash = (s: string) => s.replace(") ", ")").replace(". (2)", ".(2)");

  it("accepts a warning printed without spaces after (1) and the period", () => {
    const r = checkWarning({ status: "found", text: squash(CANONICAL_WARNING), ...bold });
    expect(r.verdict.startsWith("fail")).toBe(false);
    expect(r.notes.some((n) => /spacing differs/i.test(n))).toBe(true);
  });

  it("still surfaces it — never silently accepted", () => {
    const r = checkWarning({ status: "found", text: squash(CANONICAL_WARNING), ...bold });
    expect(r.notes.some((n) => /typography difference/i.test(n))).toBe(true);
  });

  it("does not mask a swapped word hidden by missing spaces", () => {
    const swapped = squash(CANONICAL_WARNING).replace("birth", "health");
    expect(checkWarning({ status: "found", text: swapped, ...bold }).verdict).toBe("fail_wording");
  });

  it("does not mask a dropped word", () => {
    const dropped = squash(CANONICAL_WARNING).replace("drive a car or ", "drive a car ");
    expect(checkWarning({ status: "found", text: dropped, ...bold }).verdict).toBe("fail_wording");
  });

  it("does not mask altered punctuation", () => {
    const punct = squash(CANONICAL_WARNING).replace("machinery, and", "machinery. and");
    expect(checkWarning({ status: "found", text: punct, ...bold }).verdict).toBe("fail_wording");
  });
});

/** Bold is a pixel judgment. On an image too degraded to read, that judgment
 *  is no more supportable than the word-for-word claim — so an affirmative
 *  "bold" becomes "unclear" (amber), never a failure. Measured driver: 56 of
 *  61 missed violations in docs/robustness-matrix.json were the bold check. */
describe("legibility gates the bold claim", () => {
  const exact = { status: "found" as const, text: CANONICAL_WARNING };

  it("keeps an affirmative bold claim on a crisp image", () => {
    const r = checkWarning({ ...exact, boldAdvisory: "bold", legibility: "crisp" });
    expect(r.boldAdvisory).toBe("bold");
    expect(r.verdict).toBe("pass");
  });

  it("downgrades bold to unclear when the warning is not legible", () => {
    for (const g of ["marginal", "illegible"] as const) {
      // verdict is gated to unreadable by legibility; the advisory itself is
      // what this asserts — it must not still claim bold.
      expect(checkWarning({ ...exact, boldAdvisory: "bold", legibility: g }).boldAdvisory).toBe("unclear");
    }
  });

  it("never manufactures a failure — unclear is not a fail state", () => {
    for (const g of ["marginal", "illegible"] as const) {
      const r = checkWarning({ ...exact, boldAdvisory: "bold", legibility: g });
      expect(r.verdict.startsWith("fail")).toBe(false);
    }
  });

  it("leaves an explicit not_bold finding intact", () => {
    // Downgrading only ever removes a green claim; it must not soften a
    // negative finding into "unclear" and lose the signal.
    const r = checkWarning({ ...exact, boldAdvisory: "not_bold", legibility: "marginal" });
    expect(r.boldAdvisory).toBe("not_bold");
  });

  it("routes a degraded bold claim to review, not clean", () => {
    const ex = { ...cleanExtraction(), warning_prefix_bold: "bold" as const, warning_legibility: "marginal" as const };
    expect(compareLabel(app, ex).overall).toBe("needs_review");
  });
});

/** The reader does not always stop where the statement does. On crowded real
 *  labels it appended the sulfite declaration or captured a neighbouring
 *  block — 6 of 196 approved TTB labels (docs/real-labels.json). 27 CFR 16.21
 *  fixes both boundaries, so trimming to them cannot hide a defect. */
describe("transcription is trimmed to the statement's own boundaries", () => {
  const bold = { boldAdvisory: "bold" as const, legibility: "crisp" as const };
  const check = (text: string) => checkWarning({ status: "found", text, ...bold });

  it("ignores a sulfite declaration appended after the warning", () => {
    expect(check(`${CANONICAL_WARNING} CONTAINS SULFITES`).verdict).toBe("pass");
  });

  it("ignores label copy printed before the warning", () => {
    expect(check(`PRODUCT OF FRANCE. IMPORTED BY ACME. ${CANONICAL_WARNING}`).verdict).toBe("pass");
  });

  it("handles both at once", () => {
    expect(check(`BOTTLED BY X. ${CANONICAL_WARNING} CONTAINS SULFITES. 750 ML`).verdict).toBe("pass");
  });

  it("still fails a swapped word inside the trimmed region", () => {
    const bad = CANONICAL_WARNING.replace("birth", "health");
    expect(check(`INTRO. ${bad} CONTAINS SULFITES`).verdict).toBe("fail_wording");
  });

  it("still fails a warning that is genuinely truncated", () => {
    // No closing boundary to trim at, so nothing is trimmed and the missing
    // tail is reported — a real defect must survive this.
    const cut = CANONICAL_WARNING.slice(0, CANONICAL_WARNING.length - 40);
    expect(check(cut).verdict).toBe("fail_wording");
  });

  it("still fails when the prefix is absent entirely", () => {
    const noPrefix = CANONICAL_WARNING.replace("GOVERNMENT WARNING: ", "");
    expect(check(noPrefix).verdict.startsWith("fail")).toBe(true);
  });
});
