import type { CheckResult } from "./compare/index.ts";

/** THE headline verdict, computed once and rendered everywhere.
 *
 *  Before this file, three surfaces each did their own tally — the result
 *  banner, the stepper in the top bar, and the batch status pill — and they
 *  disagreed in the ways a user actually notices: rejecting the bold type left
 *  the banner saying "1 item needs confirmation" and the stepper saying
 *  "Result: matched", on a label the agent had just ruled non-compliant. The
 *  screen has to speak with one voice, so the tally lives in one place and the
 *  surfaces only choose how much of it to show.
 */

/** The agent's ruling on one flagged field: "accepted" = looked at it and the
 *  label is fine (re-files the row as matched); "confirmed" = a real problem.
 *  The machine's verdict is never erased — the decision sits on top of it. */
export type FieldDecision = "accepted" | "confirmed";

export type VerdictTone = "ok" | "warn" | "bad";

/** Where the one check a computer can't finish — is the prefix bold? — stands. */
export type BoldStatus =
  /** the warning wording failed or couldn't be read: bold isn't the question yet */
  | "not_applicable"
  /** the stroke-width gate is still running */
  | "measuring"
  /** the gate measured the prefix heavier than the body */
  | "auto_verified"
  /** the agent looked and accepted it */
  | "accepted"
  /** the agent looked and rejected it — a regulatory failure, not a to-do */
  | "rejected"
  /** nobody has resolved it: a human glance is owed */
  | "owed";

export interface BoldInput {
  /** multi-signal gate result (null = not run / no result) */
  auto?: "bold" | "not_bold" | "human" | null;
  /** the agent's own decision — outranks the gate */
  human?: "confirmed" | "flagged" | null;
  /** the gate is still measuring, so nothing is owed yet */
  measuring?: boolean;
}

export interface VerdictChip {
  text: string;
  cls: string;
}

export interface VerdictSummary {
  tone: VerdictTone;
  /** banner headline */
  title: string;
  /** banner sentence under the headline */
  sub: string;
  /** compact form for the stepper / status pill */
  short: string;
  matched: number;
  accepted: number;
  mismatch: number;
  /** fields the reader could not make out */
  review: number;
  notRequired: number;
  warningFails: boolean;
  warningReview: boolean;
  bold: BoldStatus;
  /** hard problems: field mismatches + a failing warning + a rejected bold */
  issueCount: number;
  /** outstanding work that is not (yet) a failure */
  confirmCount: number;
  chips: VerdictChip[];
}

const wvPasses = (v: string) => v === "pass" || v === "pass_formatting_note";
const isRedVerdict = (v: string) => v === "possible_mismatch" || v === "absent_on_label";
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Prose list: "a", "a and b", "a, b and c". */
function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function boldStatus(warningVerdict: string, bold: BoldInput): BoldStatus {
  if (!wvPasses(warningVerdict)) return "not_applicable";
  if (bold.human === "flagged") return "rejected";
  if (bold.human === "confirmed") return "accepted";
  if (bold.auto === "bold") return "auto_verified";
  if (bold.measuring) return "measuring";
  return "owed";
}

export function summarizeVerdict(
  result: CheckResult,
  fieldReview: Partial<Record<string, FieldDecision>> | undefined,
  bold: BoldInput,
  /** the background second reading of the warning is still in flight, so a
   *  warning failure here is PROVISIONAL — measured on 10 real approved TTB
   *  labels, 4 came back `fail_wording` on the first reading and were
   *  downgraded to review by the second. The headline must not assert a
   *  failure it is about to withdraw. */
  confirming = false,
): VerdictSummary {
  let matched = 0, mismatch = 0, review = 0, notRequired = 0, accepted = 0;
  for (const f of result.fields) {
    if (f.verdict === "match" || f.verdict === "match_formatting") matched++;
    else if (isRedVerdict(f.verdict)) {
      // An accepted row is resolved: it counts as matched (and is named in its
      // own chip so the ruling stays visible in the headline).
      if (fieldReview?.[f.field] === "accepted") { matched++; accepted++; }
      else mismatch++;
    } else if (f.verdict === "unreadable") review++;
    else notRequired++;
  }
  const warningFails = result.warning.verdict.startsWith("fail");
  const warningReview = result.warning.verdict === "unreadable";
  const boldState = boldStatus(result.warning.verdict, bold);
  const boldRejected = boldState === "rejected";
  const boldOwed = boldState === "owed";

  const issueCount = mismatch + (warningFails ? 1 : 0) + (boldRejected ? 1 : 0);
  const confirmCount = review + (warningReview ? 1 : 0) + (boldOwed ? 1 : 0);

  let tone: VerdictTone;
  let title: string;
  let sub: string;
  let short: string;

  if (issueCount > 0) {
    tone = "bad";
    // A warning problem is a rule violation, not a field mismatch — when it is
    // the only problem it gets named, never buried in an item count.
    const warningOnly = mismatch === 0;
    title = warningOnly ? "Government warning fails" : `${issueCount} items need review`;
    if (issueCount === 1 && !warningOnly) title = "1 item needs review";
    const parts: string[] = [];
    if (warningFails) parts.push("the warning statement does not meet the requirement");
    if (boldRejected) parts.push("you rejected the bold type on “GOVERNMENT WARNING:”");
    if (mismatch > 0)
      parts.push(`${mismatch} ${plural(mismatch, "field does", "fields do")} not match the application`);
    sub = `${joinClauses(parts).replace(/^./, (c) => c.toUpperCase())}.`;
    short =
      mismatch === 0
        ? boldRejected && !warningFails ? "bold rejected" : "warning fails"
        : warningFails || boldRejected
          ? `${issueCount} problems`
          : `${mismatch} ${plural(mismatch, "mismatch", "mismatches")}`;
    // A warning failure still being double-checked is not yet a finding. The
    // headline says what is actually happening rather than asserting a verdict
    // the second reading may withdraw a moment later.
    if (confirming && warningFails) {
      tone = "warn";
      title = "Double-checking the government warning";
      sub = "The first reading found a problem with the warning statement. A second, independent reading is running before this is called a failure.";
      short = "double-checking…";
    }
  } else if (confirmCount > 0) {
    tone = "warn";
    title = `${confirmCount} ${plural(confirmCount, "item needs", "items need")} confirmation`;
    sub =
      boldOwed && confirmCount === 1
        ? "Every field matches and the warning wording is exact — just confirm “GOVERNMENT WARNING” looks bold on the label."
        : "The label matches, with a visual confirmation needed.";
    short = `${confirmCount} to confirm`;
  } else {
    tone = "ok";
    title = "Label matches the application";
    // The one thing the AI can't verify never hides behind the green headline.
    sub =
      boldState === "accepted"
        ? "All required fields match, the warning wording is exact, and you accepted the bold type."
        : boldState === "auto_verified"
          ? "All required fields match, the warning wording is exact, and the prefix strokes measure heavier than the warning body."
          : boldState === "measuring"
            ? "All required fields match and the warning wording is exact. Still measuring the bold type on “GOVERNMENT WARNING:”…"
            : "All required fields match and the warning wording is exact.";
    short = "matched";
  }

  const chips = [
    { text: `${matched} matched`, cls: "text-green" },
    accepted > 0 ? { text: `${accepted} accepted by you`, cls: "text-green font-semibold" } : null,
    mismatch > 0
      ? { text: `${mismatch} ${plural(mismatch, "mismatch", "mismatches")}`, cls: "text-red font-semibold" }
      : null,
    warningFails
      ? confirming
        ? { text: "warning: double-checking", cls: "text-amber font-semibold" }
        : { text: "warning fails", cls: "text-red font-semibold" }
      : null,
    boldRejected ? { text: "bold rejected by you", cls: "text-red font-semibold" } : null,
    review + (warningReview ? 1 : 0) > 0
      ? { text: `${review + (warningReview ? 1 : 0)} review`, cls: "text-amber font-semibold" }
      : null,
    boldOwed ? { text: "1 to confirm (bold)", cls: "text-amber" } : null,
    boldState === "measuring" ? { text: "checking bold type…", cls: "text-muted-2" } : null,
    boldState === "accepted" ? { text: "bold accepted by you", cls: "text-green" } : null,
    { text: `${notRequired} not required`, cls: "text-muted-2" },
  ].filter(Boolean) as VerdictChip[];

  return {
    tone, title, sub, short,
    matched, accepted, mismatch, review, notRequired,
    warningFails, warningReview, bold: boldState,
    issueCount, confirmCount, chips,
  };
}
