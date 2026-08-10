import type { FieldResult } from "./types.ts";

/**
 * Net contents compare by VOLUME, not string: 750 mL = 750ml = 75 cl =
 * 750 milliliters = 0.75 L. Unit surface forms are equivalent (27 CFR 5.203
 * writes "750 mL"; labels vary).
 */

const UNIT_TO_ML: Record<string, number> = {
  ml: 1, "mL": 1, milliliter: 1, milliliters: 1, millilitre: 1, millilitres: 1,
  cl: 10, centiliter: 10, centiliters: 10, centilitre: 10, centilitres: 10,
  l: 1000, liter: 1000, liters: 1000, litre: 1000, litres: 1000,
  "fl oz": 29.5735, "fluid ounce": 29.5735, "fluid ounces": 29.5735, oz: 29.5735,
};

export function parseVolumeMl(raw: string): number | null {
  // Collapse US thousands separators ("1,000 ml") BEFORE unit parsing; only a
  // comma followed by 1-2 digits is treated as a decimal comma.
  const s = raw
    .toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const m = s.match(/(\d+(?:[.,]\d{1,2})?)\s*(fl\.? ?oz\.?|fluid ounces?|millilitres?|milliliters?|centilitres?|centiliters?|litres?|liters?|ml|cl|l|oz)\b/);
  if (!m) return null;
  const value = parseFloat(m[1].replace(",", "."));
  const unitKey = m[2].replace(/\./g, "").replace(/\s+/g, " ");
  const factor =
    UNIT_TO_ML[unitKey] ??
    UNIT_TO_ML[unitKey.replace(/s$/, "")] ??
    (unitKey.startsWith("fl") ? UNIT_TO_ML["fl oz"] : undefined);
  if (factor === undefined) return null;
  return value * factor;
}

export function compareNetContents(applicationValue: string, labelValue: string): FieldResult {
  const field = "net_contents";
  const app = parseVolumeMl(applicationValue);
  const label = parseVolumeMl(labelValue);

  if (app === null || label === null) {
    return {
      field,
      verdict: "possible_mismatch",
      applicationValue,
      labelValue,
      note: "Could not parse a volume from one side — compare manually.",
    };
  }
  // Relative tolerance: 25.4 fl oz (751.17 mL) is the customary printed
  // equivalent of 750 mL — a 0.5% band accepts unit-conversion rounding
  // while still catching real size differences (750 vs 700 = 6.7%).
  if (Math.abs(app - label) > Math.max(0.5, app * 0.005)) {
    return {
      field,
      verdict: "possible_mismatch",
      applicationValue,
      labelValue,
      note: `Label shows ${Math.round(label)} mL; application says ${Math.round(app)} mL.`,
    };
  }
  const sameText = applicationValue.trim().toLowerCase() === labelValue.trim().toLowerCase();
  return {
    field,
    verdict: sameText ? "match" : "match_formatting",
    applicationValue,
    labelValue,
    similarity: 1,
    note: sameText ? undefined : `Same volume, different formats ("${labelValue.trim()}" vs "${applicationValue.trim()}").`,
  };
}
