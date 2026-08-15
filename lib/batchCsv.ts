/** Shape checks for an uploaded batch spreadsheet, kept out of the component so
 *  they can be pinned by tests. */

/** Columns only ever produced by the results export, never present in an
 *  application spreadsheet. */
const RESULT_ONLY_HEADERS = ["overall", "government_warning", "bold_check", "agent_review"];

/**
 * True when the uploaded spreadsheet is this app's own results export.
 *
 * Why this needs its own guard rather than falling out of the existing checks:
 * the export carries `filename, brand_name, class_type, alcohol_content,
 * net_contents` — every column REQUIRED_HEADERS asks for — so it passes header
 * validation, passes the has-rows check, and passes the all-fields-blank check.
 * What it does NOT carry is the application VALUES. Those cells hold verdicts:
 * `brand_name` reads "match" or "mismatch (rejected by agent)", not
 * "OLD TOM DISTILLERY".
 *
 * So without this guard the batch runs to completion and compares every label
 * against the literal word "match" — reporting a confident mismatch on every
 * row of every field. That is worse than an error: an error sends the agent to
 * the file, a wrong verdict sends them to the label.
 *
 * It cannot be rescued into a working re-run either. The original application
 * values are absent from the export, so there is nothing to re-check against;
 * refusing with an explanation is the only honest outcome.
 */
export function isResultsExport(canonicalHeaders: string[]): boolean {
  const present = new Set(canonicalHeaders);
  // "overall" alone is the strong signal; require one more so a hand-made
  // spreadsheet that happens to carry a column called "overall" is not refused.
  if (!present.has("overall")) return false;
  return RESULT_ONLY_HEADERS.filter((h) => h !== "overall").some((h) => present.has(h));
}

/** What to tell the agent, in the app's voice: name what they uploaded, say why
 *  it cannot work, and give them the one action that fixes it. */
export const RESULTS_EXPORT_MESSAGE =
  "That's the results file this tool produced, not an application spreadsheet. " +
  "Its brand name and class/type columns hold verdicts (\"match\", \"mismatch\") " +
  "rather than the values to check against, so there is nothing to re-check. " +
  "Upload the spreadsheet you started with — or download the sample bundle (zip) " +
  "to see the expected format.";
