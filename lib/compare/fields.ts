import type { FieldResult, FieldVerdict } from "./types.ts";

/**
 * Fuzzy text fields (brand, class/type, bottler, origin): case and
 * punctuation differences are MATCHES, surfaced with a note — never failures
 * (STONE'S THROW vs Stone's Throw is the same brand). Content differences
 * are "possible mismatch — check", with a similarity score; the agent decides.
 */

/** Casefold + typographic-quote fold + punctuation strip + whitespace collapse. */
export function normalizeLoose(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[“”]/g, '"')
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // strip diacritics
    .replace(/[^\p{L}\p{N}\s]/gu, "") // strip punctuation
    .replace(/\s+/g, " ")
    .trim();
}

/** The TTB responsibility statement that introduces a bottler's name.
 *
 *  27 CFR 5.36 requires the name and address to be preceded by a phrase like
 *  "BOTTLED BY" or "DISTILLED AND BOTTLED BY". An application form carries the
 *  name and address alone, so whether that phrase lands in the comparison is
 *  decided by how much of the line the reader happens to return — and it
 *  varies. On two real approved back labels checked minutes apart, one came
 *  back as "BACK 40 LLC COLUMBIA, ILLINOIS" (matched) and the other as
 *  "Bottled and Blended By Wise Ass Bottling Co. Bardstown, KY" (flagged at
 *  59% similar, on a bottler the agent had typed correctly). The phrase is
 *  boilerplate, not identity, so it comes off BOTH sides before comparing —
 *  and only for comparing. What the agent sees is the text as printed.
 */
const RESPONSIBILITY_LEAD_IN =
  /^(?:hand\s+|small\s+batch\s+)*(?:bottled|distilled|produced|brewed|vinted|blended|packed|canned|imported|manufactured|made|prepared)(?:\s*(?:and|&)\s*(?:bottled|blended|distilled|packed|canned|brewed|vinted|aged))*\s+(?:by|for)\s+/;

/** Applied to already-normalised text (casefolded, punctuation stripped). */
export function stripResponsibilityLeadIn(normalized: string): string {
  return normalized.replace(RESPONSIBILITY_LEAD_IN, "").trim();
}

/** Levenshtein similarity ratio 0..1. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const prev = new Array(b.length + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

export function compareTextField(
  field: string,
  applicationValue: string,
  label: { status: "found" | "absent" | "unreadable"; text: string },
  opts: { optional?: boolean; stripLeadIn?: boolean } = {},
): FieldResult {
  const applicationTrimmed = applicationValue.trim();
  if (!applicationTrimmed) {
    return {
      field,
      verdict: "not_provided",
      applicationValue,
      labelValue: label.text,
      note: opts.optional ? "Not provided on the application — skipped." : undefined,
    };
  }
  if (label.status === "absent") {
    return {
      field,
      verdict: "absent_on_label",
      applicationValue,
      labelValue: "",
      note: "Not found on the label.",
    };
  }
  if (label.status === "unreadable") {
    return {
      field,
      verdict: "unreadable",
      applicationValue,
      labelValue: label.text,
      note: "Present on the label but not readable from this image — check manually.",
    };
  }

  const labelTrimmed = label.text.trim();
  const rawApp = normalizeLoose(applicationTrimmed);
  const rawLabel = normalizeLoose(labelTrimmed);
  // The bottler field compares the ENTITY, not the regulatory phrase in front
  // of it (see RESPONSIBILITY_LEAD_IN).
  const normApp = opts.stripLeadIn ? stripResponsibilityLeadIn(rawApp) : rawApp;
  const normLabel = opts.stripLeadIn ? stripResponsibilityLeadIn(rawLabel) : rawLabel;
  const leadInDiffered = normApp !== rawApp || normLabel !== rawLabel;

  if (normApp === normLabel) {
    const identical = applicationTrimmed === labelTrimmed;
    const verdict: FieldVerdict = identical ? "match" : "match_formatting";
    return {
      field,
      verdict,
      applicationValue,
      labelValue: labelTrimmed,
      similarity: 1,
      note: identical
        ? undefined
        : leadInDiffered
          ? `Same ${field.replace(/_/g, " ")} — the label also prints the "bottled by" statement the regulation requires ("${labelTrimmed}" vs "${applicationTrimmed}").`
          : `Same ${field.replace(/_/g, " ")}, different formatting ("${labelTrimmed}" vs "${applicationTrimmed}").`,
    };
  }

  const sim = similarity(normApp, normLabel);
  return {
    field,
    verdict: "possible_mismatch",
    applicationValue,
    labelValue: labelTrimmed,
    similarity: Math.round(sim * 100) / 100,
    note:
      sim >= 0.8
        ? `Close but not identical (${Math.round(sim * 100)}% similar) — check which is correct.`
        : `Label and application differ substantially (${Math.round(sim * 100)}% similar).`,
  };
}
