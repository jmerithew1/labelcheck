/**
 * Canonical Government Health Warning text, 27 CFR 16.21 — verified
 * character-for-character against the GPO CFR XML and Cornell LII mirrors
 * (see docs/spec.md SME notes). Load-bearing punctuation: the colon after
 * GOVERNMENT WARNING, the "(1)"/"(2)" numbering, "Surgeon General" (no
 * apostrophe-s), and the comma before "and may cause health problems."
 */
export const CANONICAL_WARNING =
  "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";

/** The two words that must be ALL CAPS and bold per §16.22(a)(2).
 *  The colon is mandatory text (§16.21) but sits outside the caps/bold portion. */
export const WARNING_PREFIX = "GOVERNMENT WARNING";
