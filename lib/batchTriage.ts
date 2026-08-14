import type { CheckResult } from "@/lib/compare/index.ts";
import type { BoldGateResult } from "@/lib/compare/boldGate.ts";
import type { FieldDecision } from "@/components/ResultView.tsx";

/** The slice of a batch row the triage logic reads — pure data, so the
 *  bucketing rules live here (unit-tested) instead of inside the component.
 *  BatchReview's own BatchRow satisfies this structurally. */
export interface TriageRow {
  status: "queued" | "checking" | "done" | "error";
  result?: CheckResult;
  /** Human bold spot-check: confirmed = glanced and looks bold; flagged =
   *  glanced and does NOT look bold (moves the row to Needs review). */
  boldReview?: "confirmed" | "flagged";
  /** Machine gate result: "bold" auto-resolves the glance, "not_bold"
   *  escalates to review, "human" = measured but inconclusive. undefined =
   *  still being measured. A human decision always wins. */
  boldAuto?: BoldGateResult;
  /** The agent's ruling on the whole label. Outranks every machine state. */
  agentReview?: "ok" | "correction";
  /** Per-field rulings on flagged comparison rows. */
  fieldReview?: Partial<Record<string, FieldDecision>>;
}

// "bold_checking" is deliberately its own bucket rather than a flavour of
// review or an early green. A row the machine cleared, whose bold prefix is
// still being measured, is not a finding — filing it under Need review made a
// 250-label batch open with all 250 rows demanding attention, which reads as
// "the tool distrusts everything" and destroys the triage the page exists
// for. It is not Matched either, because a green tick has to mean finished.
// It is a third thing, it is temporary, and it is counted as itself.
export type Bucket = "matched" | "review" | "bold_checking" | "not_required" | "error" | "pending";

/** Flagged comparison fields — the ones a per-field ruling can resolve. */
export const redFields = (r: TriageRow) =>
  r.result ? r.result.fields.filter((f) => f.verdict === "possible_mismatch" || f.verdict === "absent_on_label") : [];

/** A needs-review row whose every flagged field the agent has accepted (and
 *  nothing else is outstanding) is resolved — it earns the same treatment as
 *  a clean row without a second "Accept label" click. Warning failures are
 *  never resolvable this way: those are regulatory hard fails. */
export const resolvedByFieldReview = (r: TriageRow): boolean => {
  if (!r.result || r.result.overall !== "needs_review") return false;
  if (r.result.warning.verdict.startsWith("fail") || r.result.warning.verdict === "unreadable") return false;
  if (r.result.fields.some((f) => f.verdict === "unreadable")) return false;
  const reds = redFields(r);
  return reds.length > 0 && reds.every((f) => r.fieldReview?.[f.field] === "accepted");
};

/** Rows where the warning text passed — bold is the one element left for a
 *  human glance (the AI advisory never decides). */
export const boldEligible = (r: TriageRow): boolean =>
  r.status === "done" && !!r.result &&
  (r.result.warning.verdict === "pass" || r.result.warning.verdict === "pass_formatting_note");

/** Still owes a human glance: no ruling, no human bold decision, and the
 *  measurement gate has RUN and did not confidently verify it. Rows still
 *  being measured are excluded so the dot, the chip and the strip always
 *  describe the same set. */
export const boldPendingRow = (r: TriageRow): boolean =>
  boldEligible(r) && !r.agentReview && !r.boldReview &&
  r.boldAuto !== undefined && r.boldAuto !== "bold";

export function bucketOf(r: TriageRow): Bucket {
  if (r.status === "error") return "error";
  if (r.status !== "done" || !r.result) return "pending";
  // The agent's ruling on a reviewed row outranks every machine state.
  if (r.agentReview === "ok") return "matched";
  if (r.agentReview === "correction") return "review";
  // The bold pass always runs (same process as a single check, just more of
  // it), so an undecided bold on an otherwise-clean row means the measurement
  // is genuinely in flight — bold_checking, not review (it is not a finding)
  // and not matched (a green tick means finished; the 72-row run recorded an
  // early green read that was optimistic by 16 rows). A row with real
  // findings stays review: bold is not why it needs attention.
  const cleanEnough = r.result.overall === "clean" || resolvedByFieldReview(r);
  if (boldEligible(r) && r.boldAuto === undefined && !r.boldReview) {
    return cleanEnough ? "bold_checking" : "review";
  }
  // An agent's flag outranks the clean verdict — a human said "not bold."
  if (r.boldReview === "flagged") return "review";
  // A confident machine "not bold" escalates too, unless a human overruled it.
  if (r.boldAuto === "not_bold" && r.boldReview !== "confirmed") return "review";
  // An owed bold glance IS review work. (Before the measurement gate every
  // passing label owed one, which would have made this filter useless; the
  // gate resolves most of them, so the few left belong here honestly.)
  if (boldPendingRow(r)) return "review";
  if (cleanEnough) {
    const anyChecked = r.result.fields.some((f) => f.verdict !== "not_provided");
    return anyChecked ? "matched" : "not_required";
  }
  return "review";
}
