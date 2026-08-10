/** Shared verdict vocabulary. The tool surfaces; the agent decides —
 *  the ONLY hard fail verdicts belong to the government warning. */

export type FieldVerdict =
  | "match" // normalized-identical
  | "match_formatting" // same content, case/punctuation/format differs — a MATCH, surfaced
  | "possible_mismatch" // content differs — agent must look
  | "absent_on_label" // application has a value, label doesn't show it
  | "unreadable" // present on label but illegible — manual check, NOT a rejection
  | "not_provided"; // application field left blank — skipped

export interface FieldResult {
  field: string;
  verdict: FieldVerdict;
  applicationValue: string;
  labelValue: string;
  /** 0..1 similarity for fuzzy comparisons; 1 for exact */
  similarity?: number;
  /** Human-readable, verdict-language note ("Case differs: …") */
  note?: string;
}

export type WarningVerdict =
  | "pass" // word-for-word canonical + ALL-CAPS prefix
  | "pass_formatting_note" // word-for-word + caps prefix, body casing nonstandard (permitted)
  | "fail_wording" // text deviates from canonical
  | "fail_prefix_case" // prefix not ALL CAPS (e.g. title case)
  | "fail_missing" // no warning on the label
  | "unreadable"; // warning present but illegible — manual check

export interface WordDiff {
  kind: "missing" | "added" | "changed";
  /** canonical word (for missing/changed) */
  expected?: string;
  /** transcribed word (for added/changed) */
  actual?: string;
  /** index into the canonical word sequence where the deviation anchors */
  at: number;
}

export interface WarningResult {
  verdict: WarningVerdict;
  labelText: string;
  /** word-level deviations vs canonical (empty when wording is exact) */
  deviations: WordDiff[];
  prefixAllCaps: boolean;
  /** Advisory AI judgment (measured 16/17 on test labels) — never a hard verdict */
  boldAdvisory: "bold" | "not_bold" | "unclear";
  notes: string[];
}
