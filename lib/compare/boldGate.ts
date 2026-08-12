/**
 * Multi-signal bold gate — the ROUND-2 validated configuration from the
 * bounded measurement loop (raw data docs/bold-multisignal-r{1,2,3}.json,
 * harnesses samples/tools/bold-multisignal-*.mjs, rationale in
 * docs/decisions.md 2026-08-11 "multi-signal bold gate ships"):
 *   train 32/57 auto-resolved, validation (6 never-seen fonts + degraded
 *   photos) 14/39 auto-resolved, ZERO confident mistakes on both.
 *
 * Signals: raw stroke-width ratio prefix/body (median min ink-run on a 3x
 * upscaled warning crop), ink-density ratio, size ratio (sanity only), plus
 * the AI stroke-weight advisory. Three outcomes:
 *   "bold"     — confidently bold (measurement AND the AI agree, strongly)
 *   "not_bold" — confidently not bold (measurement alone, strongly)
 *   "human"    — anything else routes to the human glance
 * The gate never decides pass/fail — it resolves or routes the bold glance.
 */

export interface BoldSignals {
  /** stroke-width ratio, prefix / body reference */
  swRatio: number;
  /** ink-density ratio, prefix / body reference */
  densRatio: number;
  /** cap-height ratio, prefix / body reference (sanity gate only) */
  sizeRatio: number;
  /** body stroke width in the SOURCE image's pixels (not the upscale) */
  swBodyNativePx?: number;
}

/** Round-2 tuned thresholds — frozen; re-tune only through the spike loop. */
export const BOLD_GATE = {
  swHi: 1.225, swLo: 0.875, dHi: 1.0, dLo: 1.3, sizeMin: 0.6, sizeMax: 1.7,
  // Below this the measurement is arithmetic on 1-2 pixel integers. Measured
  // on the round-2 corpus, 10 of 35 truly-REGULAR samples flip to a confident
  // "bold" if the prefix measures a single pixel wider, and 18 of 91 samples
  // sit under this floor. A ratio of small integers reads as precision it does
  // not have, so below the floor the gate declines to decide.
  minBodyStrokePx: 2,
} as const;

export type BoldGateResult = "bold" | "not_bold" | "human";

export function applyBoldGate(
  signals: BoldSignals | null,
  aiAdvisory: "bold" | "not_bold" | "unclear",
): BoldGateResult {
  if (!signals) return "human";
  const { swRatio, densRatio, sizeRatio } = signals;
  if (!Number.isFinite(swRatio) || !Number.isFinite(densRatio) || !Number.isFinite(sizeRatio)) return "human";
  if (sizeRatio < BOLD_GATE.sizeMin || sizeRatio > BOLD_GATE.sizeMax) return "human";
  // Resolution floor: not enough pixels to tell bold from regular at all.
  if (signals.swBodyNativePx !== undefined && signals.swBodyNativePx < BOLD_GATE.minBodyStrokePx) return "human";
  if (swRatio >= BOLD_GATE.swHi && densRatio >= BOLD_GATE.dHi && aiAdvisory === "bold") return "bold";
  if (swRatio <= BOLD_GATE.swLo && densRatio <= BOLD_GATE.dLo) return "not_bold";
  return "human";
}
