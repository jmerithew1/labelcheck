import type { FieldVerdict, WarningVerdict } from "@/lib/compare/types.ts";

/** Verdict presentation: WORD + ICON, never color alone (half the team is
 *  over 50; color-only status is illegible). The tool surfaces, the agent
 *  decides — hard "FAILS" language is reserved for the government warning. */

export const FIELD_VERDICT_UI: Record<
  FieldVerdict,
  { label: string; icon: string; className: string }
> = {
  match: { label: "Match", icon: "✓", className: "text-green-800 bg-green-50 border-green-200" },
  match_formatting: {
    label: "Match — formatting differs",
    icon: "✓",
    className: "text-green-800 bg-green-50 border-green-200",
  },
  possible_mismatch: {
    label: "Possible mismatch — check",
    icon: "⚠",
    className: "text-amber-900 bg-amber-50 border-amber-300",
  },
  absent_on_label: {
    label: "Not found on label",
    icon: "⚠",
    className: "text-amber-900 bg-amber-50 border-amber-300",
  },
  unreadable: {
    label: "Unreadable — check manually",
    icon: "?",
    className: "text-sky-900 bg-sky-50 border-sky-300",
  },
  not_provided: {
    label: "Not on application — skipped",
    icon: "–",
    className: "text-stone-500 bg-stone-50 border-stone-200",
  },
};

export const WARNING_VERDICT_UI: Record<
  WarningVerdict,
  { label: string; icon: string; className: string }
> = {
  pass: { label: "Passes — exact required text", icon: "✓", className: "text-green-800 bg-green-50 border-green-300" },
  pass_formatting_note: {
    label: "Passes — exact text, formatting note",
    icon: "✓",
    className: "text-green-800 bg-green-50 border-green-300",
  },
  fail_wording: {
    label: "FAILS — text must match word-for-word",
    icon: "✕",
    className: "text-red-900 bg-red-50 border-red-300",
  },
  fail_prefix_case: {
    label: "FAILS — GOVERNMENT WARNING must be in capitals",
    icon: "✕",
    className: "text-red-900 bg-red-50 border-red-300",
  },
  fail_missing: {
    label: "FAILS — no warning statement found",
    icon: "✕",
    className: "text-red-900 bg-red-50 border-red-300",
  },
  unreadable: {
    label: "Unreadable — check manually",
    icon: "?",
    className: "text-sky-900 bg-sky-50 border-sky-300",
  },
};

export const FIELD_LABELS: Record<string, string> = {
  brand_name: "Brand name",
  class_type: "Class / type",
  alcohol_content: "Alcohol content",
  net_contents: "Net contents",
  bottler_name_address: "Bottler name & address",
  country_of_origin: "Country of origin",
};
