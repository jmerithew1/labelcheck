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

/**
 * Trim a transcription to the statement's own boundaries.
 *
 * On a crowded real label the reader does not always stop where the statement
 * does: measured on TTB's registry, 6 of 196 approved labels came back with
 * the sulfite declaration appended ("…health problems. CONTAINS SULFITES") or
 * with a neighbouring block captured instead of the warning. Comparing that
 * against the canonical text reports a wording defect that is not on the
 * label — a false rejection caused by where the reader looked, not by what
 * was printed.
 *
 * 27 CFR 16.21 prescribes exactly where the statement starts and ends, so
 * both trims are safe and cannot hide a defect:
 *  - text BEFORE "GOVERNMENT WARNING" is not part of the statement;
 *  - text AFTER the closing "health problems." is a different statement.
 * If either boundary is absent — which is what a genuinely truncated or
 * altered warning looks like — nothing is trimmed and the deviation still
 * fails.
 */
export function trimToStatement(s: string): { text: string; trimmed: boolean } {
  let out = s;
  let trimmed = false;
  const start = out.search(/GOVERNMENT\s+WARNING/i);
  if (start > 0) { out = out.slice(start); trimmed = true; }
  // Anchor on the canonical closing words, keeping the terminating period.
  const end = out.search(/health\s+problems\s*\./i);
  if (end >= 0) {
    const after = out.slice(end);
    const stop = after.search(/\./);
    if (stop >= 0 && end + stop + 1 < out.length) { out = out.slice(0, end + stop + 1); trimmed = true; }
  }
  return { text: out, trimmed };
}

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
  bodyBoldAdvisory?: "bold" | "not_bold" | "unclear";
  sizeAdvisory?: "normal" | "small" | "illegibly_small";
  /** how readable the warning actually was — gates the word-for-word claim */
  legibility?: "crisp" | "marginal" | "illegible";
}): WarningResult {
  const notes: string[] = [];

  // A "bold" claim is a judgment about stroke weight in pixels — the same
  // class of claim the word-for-word gate below refuses to make on an
  // unreadable image, and for the same reason. If the warning could not be
  // read cleanly, its stroke weight cannot be judged either, so an affirmative
  // "bold" is not supportable and is downgraded to "unclear".
  //
  // Direction matters: "unclear" routes the label to review (amber) instead of
  // clean (green). This can only ever REMOVE a green check — "unclear" is not
  // a fail state, so the gate cannot manufacture a rejection. It also closes
  // the gap between this server verdict and the stricter client-side
  // measurement gate in lib/compare/boldGate.ts, rather than relying on the UI
  // to catch what the server already asserted.
  const boldAdvisory: "bold" | "not_bold" | "unclear" =
    input.boldAdvisory === "bold" &&
    (input.legibility === "illegible" || input.legibility === "marginal")
      ? "unclear"
      : input.boldAdvisory;

  const base = {
    labelText: input.text,
    boldAdvisory,
    bodyBoldAdvisory: input.bodyBoldAdvisory ?? "unclear",
    prefixAllCaps: false,
    deviations: [] as WordDiff[],
  };

  if (input.status === "absent") {
    // "No warning at all" is the gravest verdict this tool issues, so it must
    // not rest on one reading. When the typography pass — looking at the same
    // pixels — reports the warning as illegible, the two readings disagree
    // about whether a warning is even THERE: one saw nothing, the other saw
    // something it could not read. Measured: a real but tiny warning was called
    // absent on 6 degraded variants (docs/robustness-matrix.json). A disputed
    // absence is a manual check, not a rejection.
    if (input.legibility === "illegible" || input.legibility === "marginal") {
      return {
        ...base,
        verdict: "unreadable",
        notes: [
          "No warning could be read on this image, but it is too degraded to be sure one is not there. Check the label before treating the warning as missing — request a clearer image if needed.",
        ],
      };
    }
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

  const trim = trimToStatement(input.text);
  const text = normalizeTranscription(trim.text);
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

  // Spacing is typography, not wording. Real approved labels routinely set
  // "(1)According" and "defects.(2)" with no space after the numeral or the
  // period — measured on TTB's own registry, 12 of 14 sampled wording
  // failures were this and nothing else (docs/real-labels.json). Every word,
  // every character and every mark is present and in order; only the gaps
  // differ. normalizeTranscription() already treats whitespace as carrying no
  // compliance meaning by collapsing runs of it, but collapsing cannot
  // recover a space that was never printed, so the word tokenizer saw
  // "(1)According" as one token and reported a deviation.
  //
  // Comparing with all whitespace removed cannot mask a real defect: a
  // swapped, dropped or added word still differs once the gaps are gone
  // ("BIRTHDEFECTS" vs "HEALTHDEFECTS"), and so does altered punctuation.
  const spacingOnly =
    !wordingExact &&
    text.replace(/\s+/g, "").toUpperCase() === canonical.replace(/\s+/g, "").toUpperCase();

  if (!wordingExact && !spacingOnly) {
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

  // Other text sat adjacent to the statement in the reading. Two causes look
  // identical from a transcription: the label really printed something beside
  // the warning (27 CFR 16.22(a)(1) requires it "separate and apart"), or the
  // reader simply over-captured on a crowded label — measured as the latter on
  // 6 of 196 approved TTB labels. Because the two cannot be told apart from
  // the text alone, this is NOT corroborated and therefore cannot be a FAIL;
  // it is surfaced for a human, which is the cheaper error.
  if (trim.trimmed) {
    notes.push(
      "Other text was captured next to the warning statement. The warning's own wording checks out — but 27 CFR 16.22(a)(1) requires the statement to appear separate and apart from other information, so glance at the label to confirm nothing is crowding it.",
    );
  }

  // Surfaced, never hidden: the wording is complete and correct, but the
  // agent should know the spacing on the label isn't the canonical spacing.
  if (spacingOnly) {
    notes.push(
      "Every word of the warning is present and correct, but the spacing differs from the standard statement (for example “(1)According” with no space). Wording is what 27 CFR 16.21 prescribes — this is a typography difference, not a wording defect.",
    );
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
  if (boldAdvisory === "not_bold") {
    notes.push('The visual check suggests "GOVERNMENT WARNING" may NOT be in bold type (required by 27 CFR 16.22(a)(2)). Verify on the label image.');
  } else if (boldAdvisory === "unclear") {
    notes.push("Could not determine whether the warning prefix is bold — verify on the label image.");
  } else {
    notes.push("Text is exact. Bold type is judged visually and cannot be guaranteed on every label — glance at the image to confirm “GOVERNMENT WARNING” is bold.");
  }

  // 27 CFR 16.22(a): the prefix must be bold AND "the remainder ... shall not
  // appear in bold type." Same visual-judgment caveat as the prefix, so it is
  // an advisory that routes the row to review — never a hard fail.
  if (input.bodyBoldAdvisory === "bold") {
    notes.push(
      "The warning body text appears to be in BOLD type. 27 CFR 16.22(a) requires the statement after “GOVERNMENT WARNING:” to be in non-bold type — check the label image.",
    );
  }

  if (input.sizeAdvisory === "small" || input.sizeAdvisory === "illegibly_small") {
    // ResultView's "Size" row finds this note by matching /small/i on the
    // text — keep the word "small" in any rewording.
    notes.push(
      `The warning text appears ${input.sizeAdvisory === "illegibly_small" ? "barely legible — extremely small" : "unusually small"} relative to the rest of the label. Type-size minimums (27 CFR 16.22(b)) can't be checked from an image — verify against the physical container.`,
    );
  }

  // A word-for-word PASS asserts character-level equality. That claim is only
  // supportable if the characters were actually legible: on a blurred, tiny or
  // heavily compressed warning the reader reconstructs the familiar sentence
  // from memory, and a one-word alteration — exactly the evasion this check
  // exists to catch — slides through as "exact" (measured: 10 of 40 degraded
  // variants of a real word swap passed clean, docs/robustness-matrix.json).
  // So an unsupportable pass becomes "check manually". It can never create a
  // failure: a label that already failed keeps its failure.
  if (input.legibility === "illegible" || input.legibility === "marginal") {
    return {
      ...base,
      verdict: "unreadable",
      notes: [
        input.legibility === "illegible"
          ? "The warning text is not legible enough in this image to verify it word-for-word. The wording could not be checked — read it on the label or request a clearer image."
          : "The warning matched, but this image is too blurred/small to be certain every word is exact — a single altered word could be missed. Check the warning on the label or request a clearer image.",
        ...notes,
      ],
    };
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
    bodyBoldAdvisory?: "bold" | "not_bold" | "unclear";
    sizeAdvisory?: "normal" | "small" | "illegibly_small";
    legibility?: "crisp" | "marginal" | "illegible";
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
    bodyBoldAdvisory: advisories.bodyBoldAdvisory,
    sizeAdvisory: advisories.sizeAdvisory,
    legibility: advisories.legibility,
  });
  const downgrade = (note: string) => ({
    warning: { ...warning, verdict: "unreadable" as const, notes: [note, ...warning.notes] },
    overall: (overall === "warning_failure" ? "needs_review" : overall) as OverallVerdict,
    outcome: "downgraded" as const,
  });

  if (secondCheck.verdict === "pass" || secondCheck.verdict === "pass_formatting_note") {
    return downgrade("The two readings of the warning disagree — check the warning on the image before deciding.");
  }

  // Both readings failed — but did they see the SAME defect? A deliberate
  // word swap reads identically twice; a torn corner, a thumb over the text
  // or heavy compression produces a DIFFERENT misread each time. Measured on
  // damaged labels (docs/degraded-hard.json): single-word deviations that
  // don't reproduce are the dominant false-rejection cause. Agreeing that
  // "something is wrong" is not enough to assert a failure — the two reads
  // must agree on WHAT is wrong.
  if (warning.verdict === "fail_wording" && secondCheck.verdict === "fail_wording") {
    const key = (d: WordDiff) => `${d.kind}:${d.at}:${d.expected ?? ""}→${d.actual ?? ""}`;
    const firstKeys = new Set(warning.deviations.map(key));
    const agreed = secondCheck.deviations.filter((d) => firstKeys.has(key(d))).length;
    // Require a real overlap: at least one shared deviation, and the two sets
    // must be broadly the same size (a truncated read shows far more).
    const sizeRatio =
      Math.min(warning.deviations.length, secondCheck.deviations.length) /
      Math.max(warning.deviations.length, secondCheck.deviations.length, 1);
    if (agreed === 0 || sizeRatio < 0.5) {
      return downgrade(
        "Both readings of the warning found a problem, but they disagree about which words differ — that pattern means a misread (damage, glare or compression), not a label defect. Check the warning on the image.",
      );
    }
  }
  return {
    warning: {
      ...warning,
      notes: ["Confirmed by a second independent reading.", ...warning.notes],
    },
    overall,
    outcome: "confirmed",
  };
}
