import { CANONICAL_WARNING, WARNING_PREFIX } from "./canonical.ts";
import type { WarningResult, WordDiff } from "./types.ts";

/**
 * The government warning check. Deterministic and strict by design:
 * wording/punctuation deviations FAIL; the only normalization applied is
 * transcription noise that carries no compliance meaning (whitespace, line
 * wraps, curly quotes). Load-bearing punctuation — the colon, "(1)"/"(2)",
 * commas, periods — is never normalized away.
 *
 * Casing policy (27 CFR 16.22(a)(2), SME-verified):
 * - "GOVERNMENT WARNING" must be ALL CAPS → title case is a HARD FAIL.
 * - Body casing is NOT constrained by Part 16 → an all-caps body that is
 *   word-for-word correct passes with a formatting note.
 * - Bold is a separate advisory AI judgment (no deterministic pixel check).
 */

/** Normalize transcription noise ONLY. */
export function normalizeTranscription(s: string): string {
  return s
    .replace(/[‘’ʼ]/g, "'") // curly/typographic apostrophes
    .replace(/[“”]/g, '"')
    .replace(/(\p{L})-\s+(\p{L})/gu, "$1$2") // line-wrap hyphenation: "preg- nancy"
    .replace(/\s+/g, " ")
    .trim();
}

/** Word-level diff vs canonical (case-insensitive on wording; casing handled separately). */
function diffWords(canonical: string[], actual: string[]): WordDiff[] {
  // LCS over lowercased words, then read out the edit script.
  const a = canonical.map((w) => w.toLowerCase());
  const b = actual.map((w) => w.toLowerCase());
  const m = a.length, n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const diffs: WordDiff[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { i++; j++; continue; }
    // Pair a deletion+insertion at the same point into a "changed" entry
    if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      if (j < n && lcs[i + 1][j + 1] === lcs[i + 1][j]) {
        diffs.push({ kind: "changed", expected: canonical[i], actual: actual[j], at: i });
        i++; j++;
      } else {
        diffs.push({ kind: "missing", expected: canonical[i], at: i });
        i++;
      }
    } else {
      diffs.push({ kind: "added", actual: actual[j], at: i });
      j++;
    }
  }
  while (i < m) { diffs.push({ kind: "missing", expected: canonical[i], at: i }); i++; }
  while (j < n) { diffs.push({ kind: "added", actual: actual[j], at: i }); j++; }
  return diffs;
}

export function checkWarning(input: {
  status: "found" | "absent" | "unreadable";
  text: string;
  boldAdvisory: "bold" | "not_bold" | "unclear";
  sizeAdvisory?: "normal" | "small" | "illegibly_small";
}): WarningResult {
  const notes: string[] = [];
  const base = {
    labelText: input.text,
    boldAdvisory: input.boldAdvisory,
    prefixAllCaps: false,
    deviations: [] as WordDiff[],
  };

  if (input.status === "absent") {
    return {
      ...base,
      verdict: "fail_missing",
      notes: ["No Government Health Warning Statement found on the label. Required on all alcohol beverages (27 CFR 16.21)."],
    };
  }
  if (input.status === "unreadable") {
    return {
      ...base,
      verdict: "unreadable",
      notes: ["A warning statement appears present but could not be read reliably (image quality). Check the label manually — do not reject on this alone."],
    };
  }

  const text = normalizeTranscription(input.text);
  if (!text) {
    // "found" with empty text is a contradiction from the extractor —
    // treat as missing (loud) rather than diffing against an empty string.
    return {
      ...base,
      verdict: "fail_missing",
      notes: ["No readable Government Health Warning Statement was returned for this label. Required on all alcohol beverages (27 CFR 16.21)."],
    };
  }
  const canonical = CANONICAL_WARNING; // already normalized-form

  // Prefix casing: the first two words as printed must be exactly ALL CAPS.
  const prefixAllCaps = text.startsWith(WARNING_PREFIX);
  base.prefixAllCaps = prefixAllCaps;

  // Wording: word-for-word, punctuation included, case-insensitive here
  // (casing is adjudicated separately so we can tell "wrong words" apart
  // from "right words, wrong case").
  const wordingExact = text.toUpperCase() === canonical.toUpperCase();

  if (!wordingExact) {
    const deviations = diffWords(canonical.split(" "), text.split(" "));
    const parts = deviations.slice(0, 5).map((d) =>
      d.kind === "missing"
        ? `missing "${d.expected}"`
        : d.kind === "added"
          ? `unexpected "${d.actual}"`
          : `"${d.actual}" should be "${d.expected}"`,
    );
    return {
      ...base,
      deviations,
      verdict: "fail_wording",
      notes: [`Warning text deviates from the required statement: ${parts.join("; ")}${deviations.length > 5 ? "; …" : ""}.`],
    };
  }

  if (!prefixAllCaps) {
    const printedPrefix = text.slice(0, WARNING_PREFIX.length);
    return {
      ...base,
      verdict: "fail_prefix_case",
      notes: [`"${printedPrefix}" must appear as "${WARNING_PREFIX}" in capital letters (27 CFR 16.22(a)(2)).`],
    };
  }

  // Bold is the one requirement with no deterministic check, and the AI
  // judgment's measured miss is exactly the evasion case (all-caps but not
  // bold). Never let a green verdict imply bold was verified — hedge on
  // EVERY outcome, including "bold" (fail-open guard, per red-team finding).
  if (input.boldAdvisory === "not_bold") {
    notes.push('AI visual check suggests "GOVERNMENT WARNING" may NOT be in bold type (required by 27 CFR 16.22(a)(2)). Verify on the label image.');
  } else if (input.boldAdvisory === "unclear") {
    notes.push("Could not determine whether the warning prefix is bold — verify on the label image.");
  } else {
    notes.push("Text is exact. Bold type on “GOVERNMENT WARNING” is AI-judged only (right on 16 of 17 test labels; the miss was a non-bold prefix) — glance at the image to confirm boldness.");
  }

  if (input.sizeAdvisory === "small" || input.sizeAdvisory === "illegibly_small") {
    // ResultView's "Size" row finds this note by matching /small/i on the
    // text — keep the word "small" in any rewording.
    notes.push(
      `The warning text appears ${input.sizeAdvisory === "illegibly_small" ? "barely legible — extremely small" : "unusually small"} relative to the rest of the label. Type-size minimums (27 CFR 16.22(b)) can't be checked from an image — verify against the physical container.`,
    );
  }

  // Body casing: exact-case match to canonical = clean pass; otherwise the
  // wording is right and the prefix is caps — Part 16 does not constrain
  // body casing, so it's a pass with a formatting note.
  if (text === canonical) {
    return { ...base, verdict: "pass", notes };
  }
  notes.unshift("Warning wording is exact; body letter-casing differs from the standard rendering (permitted — Part 16 constrains only the prefix).");
  return { ...base, verdict: "pass_formatting_note", notes };
}

export type OverallVerdict = "clean" | "needs_review" | "warning_failure" | "not_a_label";

/**
 * Fold a second independent warning reading into an existing failing verdict.
 * False-rejection guard: a transcription misread can manufacture a warning
 * failure on a clean label — the costliest error this tool can make. If the
 * two readings disagree on the verdict, downgrade to "check manually" instead
 * of asserting a failure. Pure so both the blocking path (/api/check for
 * batch rows) and the async path (/api/confirm for single checks) share it.
 */
export function applySecondReading(
  warning: WarningResult,
  overall: OverallVerdict,
  second: { status: "found" | "absent" | "unreadable"; text: string } | null,
  advisories: {
    boldAdvisory: "bold" | "not_bold" | "unclear";
    sizeAdvisory?: "normal" | "small" | "illegibly_small";
  },
): { warning: WarningResult; overall: OverallVerdict; outcome: "confirmed" | "downgraded" | "unavailable" } {
  if (!second || second.status !== "found") {
    // Best-effort confirmation: on any API problem the original single-reading
    // verdict stands, unchanged.
    return { warning, overall, outcome: "unavailable" };
  }
  const secondCheck = checkWarning({
    status: "found",
    text: second.text,
    boldAdvisory: advisories.boldAdvisory,
    sizeAdvisory: advisories.sizeAdvisory,
  });
  if (secondCheck.verdict === "pass" || secondCheck.verdict === "pass_formatting_note") {
    return {
      warning: {
        ...warning,
        verdict: "unreadable",
        notes: [
          "Two independent AI readings of the warning disagree — the first found a deviation, the second reads it as exact. This is usually a transcription artifact, not a label defect. Check the warning on the image before acting.",
          ...warning.notes,
        ],
      },
      overall: overall === "warning_failure" ? "needs_review" : overall,
      outcome: "downgraded",
    };
  }
  return {
    warning: {
      ...warning,
      notes: ["Confirmed by a second independent AI reading.", ...warning.notes],
    },
    overall,
    outcome: "confirmed",
  };
}
