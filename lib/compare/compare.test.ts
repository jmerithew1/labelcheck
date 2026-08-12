import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { CANONICAL_WARNING } from "./canonical.ts";
import { checkWarning, normalizeTranscription } from "./warning.ts";
import { compareAbv, parseAbv } from "./abv.ts";
import { compareNetContents, parseVolumeMl } from "./netContents.ts";
import { compareTextField } from "./fields.ts";
import { compareLabel, type ApplicationData } from "./index.ts";
import type { LabelExtraction } from "../vision/contract.ts";

const found = (text: string) => ({ status: "found" as const, text });

// ---------- C7/C8: government warning — exact, strict, deterministic ----------

describe("warning check (C7, C8)", () => {
  it("passes the canonical text exactly (C7)", () => {
    const r = checkWarning({ status: "found", text: CANONICAL_WARNING, boldAdvisory: "bold" });
    expect(r.verdict).toBe("pass");
    expect(r.deviations).toHaveLength(0);
  });

  it("hard-fails a title-case prefix (C8 — Jenny Park's case)", () => {
    const titleCase = CANONICAL_WARNING.replace("GOVERNMENT WARNING:", "Government Warning:");
    const r = checkWarning({ status: "found", text: titleCase, boldAdvisory: "not_bold" });
    expect(r.verdict).toBe("fail_prefix_case");
    expect(r.notes[0]).toContain("capital letters");
  });

  it("fails a swapped word with the deviation named (C7 adversarial)", () => {
    const swapped = CANONICAL_WARNING.replace("birth defects", "health defects");
    const r = checkWarning({ status: "found", text: swapped, boldAdvisory: "bold" });
    expect(r.verdict).toBe("fail_wording");
    expect(r.deviations.some((d) => d.kind === "changed" && d.expected === "birth" && d.actual === "health")).toBe(true);
  });

  it("fails a dropped word with the deviation named (C7 adversarial)", () => {
    const dropped = CANONICAL_WARNING.replace("operate ", "");
    const r = checkWarning({ status: "found", text: dropped, boldAdvisory: "bold" });
    expect(r.verdict).toBe("fail_wording");
    expect(r.deviations.some((d) => d.kind === "missing" && d.expected === "operate")).toBe(true);
  });

  it("fails punctuation drift — the comma before 'and may cause' is load-bearing (C7)", () => {
    const noComma = CANONICAL_WARNING.replace("machinery,", "machinery");
    const r = checkWarning({ status: "found", text: noComma, boldAdvisory: "bold" });
    expect(r.verdict).toBe("fail_wording");
  });

  it("passes an ALL-CAPS body with a formatting note (SME: Part 16 constrains only the prefix)", () => {
    const r = checkWarning({ status: "found", text: CANONICAL_WARNING.toUpperCase(), boldAdvisory: "bold" });
    expect(r.verdict).toBe("pass_formatting_note");
  });

  it("fails a missing warning loudly", () => {
    const r = checkWarning({ status: "absent", text: "", boldAdvisory: "unclear" });
    expect(r.verdict).toBe("fail_missing");
  });

  it("keeps unreadable distinct from missing — manual check, not rejection", () => {
    const r = checkWarning({ status: "unreadable", text: "", boldAdvisory: "unclear" });
    expect(r.verdict).toBe("unreadable");
    expect(r.notes[0]).toContain("manually");
  });

  it("normalizes only transcription noise: line-wrap hyphens, curly quotes, whitespace", () => {
    expect(normalizeTranscription("preg- nancy")).toBe("pregnancy");
    expect(normalizeTranscription("Surgeon  General’s")).toBe("Surgeon General's");
    const wrapped = CANONICAL_WARNING.replace("pregnancy", "preg- nancy").replace(/ /g, "  ");
    const r = checkWarning({ status: "found", text: wrapped, boldAdvisory: "bold" });
    expect(r.verdict).toBe("pass");
  });

  it("surfaces a not-bold advisory without failing the check (C9 — advisory only)", () => {
    const r = checkWarning({ status: "found", text: CANONICAL_WARNING, boldAdvisory: "not_bold" });
    expect(r.verdict).toBe("pass");
    expect(r.notes.join(" ")).toContain("bold");
    expect(r.notes.join(" ")).toContain("Verify on the label image");
  });
});

// ---------- C4: alcohol content — numeric, format-tolerant ----------

describe("ABV comparison (C4)", () => {
  it("matches the rubric's exact example: label '45% Alc./Vol. (90 Proof)' vs application '45%'", () => {
    const r = compareAbv("45%", "45% Alc./Vol. (90 Proof)");
    expect(["match", "match_formatting"]).toContain(r.verdict);
  });

  it("parses permitted format variants (27 CFR 5.65 abbreviations)", () => {
    expect(parseAbv("Alc. 45% by Vol.").percent).toBe(45);
    expect(parseAbv("ALC 45% BY VOL").percent).toBe(45);
    expect(parseAbv("13.5% Alc. by Vol.").percent).toBe(13.5);
    expect(parseAbv("90 proof").percent).toBe(45);
  });

  it("flags a real percentage difference", () => {
    const r = compareAbv("45%", "40% Alc./Vol.");
    expect(r.verdict).toBe("possible_mismatch");
  });

  it("flags label-internal proof inconsistency (proof must equal 2×ABV)", () => {
    const r = compareAbv("45%", "45% Alc./Vol. (80 Proof)");
    expect(r.verdict).toBe("possible_mismatch");
    expect(r.note).toContain("proof");
  });

  it("degrades to manual-compare when unparseable, never a silent pass", () => {
    const r = compareAbv("45%", "forty-five percent-ish");
    expect(r.verdict).toBe("possible_mismatch");
  });
});

// ---------- C5: net contents — volume equivalence ----------

describe("net contents comparison (C5)", () => {
  it("treats 750 mL / 750ml / 75 cl / 750 milliliters as the same volume", () => {
    for (const label of ["750ml", "75 cl", "750 milliliters", "0.75 L"]) {
      const r = compareNetContents("750 mL", label);
      expect(["match", "match_formatting"]).toContain(r.verdict);
    }
  });

  it("flags different volumes", () => {
    const r = compareNetContents("750 mL", "700 mL");
    expect(r.verdict).toBe("possible_mismatch");
  });

  it("parses common forms", () => {
    expect(parseVolumeMl("750 mL")).toBe(750);
    expect(parseVolumeMl("1.75 L")).toBe(1750);
    expect(parseVolumeMl("355 ml")).toBe(355);
  });
});

// ---------- C10: fuzzy fields — case/punct = match, surfaced ----------

describe("fuzzy text fields (C10, C12, C13)", () => {
  it("matches STONE'S THROW vs Stone's Throw as formatting-only (Dave Morrison's case)", () => {
    const r = compareTextField("brand_name", "Stone's Throw", found("STONE'S THROW"));
    expect(r.verdict).toBe("match_formatting");
    expect(r.similarity).toBe(1);
  });

  it("matches typographic vs straight apostrophes", () => {
    const r = compareTextField("brand_name", "Stone's Throw", found("Stone’s Throw"));
    expect(["match", "match_formatting"]).toContain(r.verdict);
  });

  it("surfaces a genuinely different brand as possible mismatch, not a hard fail", () => {
    const r = compareTextField("brand_name", "OLD TOM DISTILLERY", found("OLD CROW DISTILLERY"));
    expect(r.verdict).toBe("possible_mismatch");
    expect(r.similarity).toBeLessThan(1);
  });

  it("compares class/type through the same judgment path (C3)", () => {
    const ok = compareTextField("class_type", "Kentucky Straight Bourbon Whiskey", found("KENTUCKY STRAIGHT BOURBON WHISKEY"));
    expect(ok.verdict).toBe("match_formatting");
    expect(ok.similarity).toBe(1);
    const bad = compareTextField("class_type", "Kentucky Straight Bourbon Whiskey", found("Small Batch Bourbon Whiskey"));
    expect(bad.verdict).toBe("possible_mismatch");
  });

  it("skips blank optional fields (C12/C13)", () => {
    const r = compareTextField("country_of_origin", "", found("Product of France"), { optional: true });
    expect(r.verdict).toBe("not_provided");
  });

  it("keeps absent and unreadable distinct", () => {
    expect(compareTextField("brand_name", "X", { status: "absent", text: "" }).verdict).toBe("absent_on_label");
    expect(compareTextField("brand_name", "X", { status: "unreadable", text: "" }).verdict).toBe("unreadable");
  });
});

// ---------- Integration: real sample ground truths → triage buckets ----------

const root = path.join(__dirname, "..", "..");
function extractionFromSidecar(name: string, bold?: "bold" | "not_bold"): LabelExtraction {
  const sc = JSON.parse(
    fs.readFileSync(path.join(root, "samples", "labels", `${name}.json`), "utf8"),
  );
  const has = (v: string | null) => (v ? found(v) : { status: "absent" as const, text: "" });
  return {
    is_alcohol_label: true,
    brand_name: has(sc.brand_name),
    class_type: has(sc.class_type),
    alcohol_content: has(sc.alcohol_content),
    net_contents: has(sc.net_contents),
    bottler_name_address: { status: "absent", text: "" },
    country_of_origin: { status: "absent", text: "" },
    warning: sc.warning_text_verbatim ? found(sc.warning_text_verbatim) : { status: "absent", text: "" },
    warning_prefix_bold: bold ?? (sc.warning_prefix_bold ? "bold" : "not_bold"),
    warning_body_bold: "not_bold",
    warning_text_size: "normal",
  };
}
const oldTomApp: ApplicationData = {
  brand_name: "OLD TOM DISTILLERY",
  class_type: "Kentucky Straight Bourbon Whiskey",
  alcohol_content: "45% Alc./Vol. (90 Proof)",
  net_contents: "750 mL",
};

describe("compareLabel integration on sample ground truths", () => {
  it("clean-match → clean", () => {
    expect(compareLabel(oldTomApp, extractionFromSidecar("clean-match")).overall).toBe("clean");
  });

  it("case-diff brand → still clean, surfaced as formatting match (C10/C11)", () => {
    const r = compareLabel(oldTomApp, extractionFromSidecar("case-diff"));
    expect(r.overall).toBe("clean");
    expect(r.fields.find((f) => f.field === "brand_name")?.verdict).toBe("match_formatting");
  });

  it("title-case-prefix → warning_failure", () => {
    expect(compareLabel(oldTomApp, extractionFromSidecar("title-case-prefix")).overall).toBe("warning_failure");
  });

  it("word-swap → warning_failure", () => {
    expect(compareLabel(oldTomApp, extractionFromSidecar("word-swap")).overall).toBe("warning_failure");
  });

  it("missing-warning → warning_failure", () => {
    expect(compareLabel(oldTomApp, extractionFromSidecar("missing-warning")).overall).toBe("warning_failure");
  });

  it("non-bold prefix with perfect text → needs_review (advisory), never auto-fail", () => {
    const r = compareLabel(oldTomApp, extractionFromSidecar("non-bold-prefix", "not_bold"));
    expect(r.overall).toBe("needs_review");
    expect(r.warning.verdict).toBe("pass");
  });

  it("brand mismatch → needs_review", () => {
    const ex = extractionFromSidecar("clean-match");
    ex.brand_name = found("OLD CROW DISTILLERY");
    expect(compareLabel(oldTomApp, ex).overall).toBe("needs_review");
  });

  it("not-a-label guard", () => {
    const ex = extractionFromSidecar("clean-match");
    ex.is_alcohol_label = false;
    expect(compareLabel(oldTomApp, ex).overall).toBe("not_a_label");
  });
});
