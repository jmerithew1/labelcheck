import type { FieldResult } from "./types.ts";

/**
 * Alcohol-content comparison is NUMERIC, not textual: "45% Alc./Vol. (90 Proof)"
 * and "45%" are the same statement (27 CFR 5.65 permits abbreviation variants),
 * so we parse percentage (and optional proof) from both sides and compare
 * values. Proof, when present, is cross-checked as 2 × ABV.
 */

export interface ParsedAbv {
  percent: number | null;
  proof: number | null;
}

export function parseAbv(raw: string): ParsedAbv {
  const s = raw.toLowerCase().replace(/\s+/g, " ").trim();
  let percent: number | null = null;
  let proof: number | null = null;

  // Proof: "90 proof" / "(90 Proof)"
  const proofMatch = s.match(/(\d+(?:\.\d+)?)\s*proof/);
  if (proofMatch) proof = parseFloat(proofMatch[1]);

  // Percent forms: "45%", "45 percent", "alc. 45% by vol.", "alcohol 13.5% by volume"
  const pctMatch =
    s.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/) ??
    s.match(/(?:alc(?:ohol)?\.?\s*)(\d+(?:\.\d+)?)/);
  if (pctMatch) percent = parseFloat(pctMatch[1]);

  // Percent absent but proof present → derivable
  if (percent === null && proof !== null) percent = proof / 2;

  return { percent, proof };
}

export function compareAbv(applicationValue: string, labelValue: string): FieldResult {
  const field = "alcohol_content";
  const app = parseAbv(applicationValue);
  const label = parseAbv(labelValue);

  if (app.percent === null || label.percent === null) {
    return {
      field,
      verdict: "possible_mismatch",
      applicationValue,
      labelValue,
      note: "Could not parse an alcohol percentage from one side — compare manually.",
    };
  }

  const notes: string[] = [];
  if (Math.abs(app.percent - label.percent) > 0.001) {
    return {
      field,
      verdict: "possible_mismatch",
      applicationValue,
      labelValue,
      note: `Label reads ${label.percent}% ABV; application says ${app.percent}%.`,
    };
  }

  // Percent agrees. Proof consistency check when the label states proof.
  if (label.proof !== null && Math.abs(label.proof - label.percent * 2) > 0.01) {
    return {
      field,
      verdict: "possible_mismatch",
      applicationValue,
      labelValue,
      note: `Label's proof (${label.proof}) does not equal 2 × ABV (${label.percent}%) — internal inconsistency on the label.`,
    };
  }

  const sameText = applicationValue.trim() === labelValue.trim();
  if (!sameText) notes.push(`Same alcohol content, different formats ("${labelValue.trim()}" vs "${applicationValue.trim()}").`);
  return {
    field,
    verdict: sameText ? "match" : "match_formatting",
    applicationValue,
    labelValue,
    similarity: 1,
    note: notes[0],
  };
}
