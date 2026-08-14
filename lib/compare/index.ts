import type { LabelExtraction } from "../vision/contract.ts";
import type { FieldResult, WarningResult } from "./types.ts";
import { compareAbv } from "./abv.ts";
import { compareNetContents } from "./netContents.ts";
import { compareTextField } from "./fields.ts";
import { checkWarning } from "./warning.ts";

export interface ApplicationData {
  brand_name: string;
  class_type: string;
  alcohol_content: string;
  net_contents: string;
  /** optional */
  bottler_name_address?: string;
  /** optional (imports) */
  country_of_origin?: string;
}

export interface CheckResult {
  is_alcohol_label: boolean;
  fields: FieldResult[];
  warning: WarningResult;
  /** Triage bucket derived deterministically from the verdicts. */
  overall: "clean" | "needs_review" | "warning_failure" | "not_a_label";
}

function wrapNumeric(
  result: FieldResult,
  label: { status: "found" | "absent" | "unreadable"; text: string },
  applicationValue: string,
  field: string,
): FieldResult {
  if (!applicationValue.trim()) {
    return { field, verdict: "not_provided", applicationValue, labelValue: label.text };
  }
  if (label.status === "absent") {
    return { field, verdict: "absent_on_label", applicationValue, labelValue: "", note: "Not found on the label." };
  }
  if (label.status === "unreadable") {
    return { field, verdict: "unreadable", applicationValue, labelValue: label.text, note: "Present on the label but not readable from this image — check manually." };
  }
  return result;
}

export function compareLabel(app: ApplicationData, ex: LabelExtraction): CheckResult {
  const fields: FieldResult[] = [
    compareTextField("brand_name", app.brand_name, ex.brand_name),
    compareTextField("class_type", app.class_type, ex.class_type),
    wrapNumeric(
      compareAbv(app.alcohol_content, ex.alcohol_content.text),
      ex.alcohol_content, app.alcohol_content, "alcohol_content",
    ),
    wrapNumeric(
      compareNetContents(app.net_contents, ex.net_contents.text),
      ex.net_contents, app.net_contents, "net_contents",
    ),
    compareTextField("bottler_name_address", app.bottler_name_address ?? "", ex.bottler_name_address, { optional: true, stripLeadIn: true }),
    compareTextField("country_of_origin", app.country_of_origin ?? "", ex.country_of_origin, { optional: true }),
  ];

  const warning = checkWarning({
    status: ex.warning.status,
    text: ex.warning.text,
    boldAdvisory: ex.warning_prefix_bold,
    bodyBoldAdvisory: ex.warning_body_bold,
    legibility: ex.warning_legibility,
    sizeAdvisory: ex.warning_text_size,
  });

  let overall: CheckResult["overall"];
  if (!ex.is_alcohol_label) {
    overall = "not_a_label";
  } else if (warning.verdict.startsWith("fail")) {
    overall = "warning_failure";
  } else if (
    warning.verdict === "unreadable" ||
    warning.boldAdvisory !== "bold" ||
    warning.bodyBoldAdvisory === "bold" ||
    fields.some((f) => ["possible_mismatch", "absent_on_label", "unreadable"].includes(f.verdict))
  ) {
    overall = "needs_review";
  } else {
    overall = "clean";
  }

  return { is_alcohol_label: ex.is_alcohol_label, fields, warning, overall };
}
