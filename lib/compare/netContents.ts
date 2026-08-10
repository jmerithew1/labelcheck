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
  const s = raw.toLowerCase().replace(/\s+/g, " ").trim();
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*(fl\.? ?oz\.?|fluid ounces?|millilitres?|milliliters?|centilitres?|centiliters?|litres?|liters?|ml|cl|l|oz)\b/);
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
  if (Math.abs(app - label) > 0.5) {
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
