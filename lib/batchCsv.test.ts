import { describe, it, expect } from "vitest";
import { isResultsExport } from "./batchCsv.ts";

/** These pin the round-trip guard. The regression that motivated them: the
 *  batch page offers a "Save results (CSV)" download, and that file carries
 *  every column REQUIRED_HEADERS asks for — so re-uploading it passed all
 *  existing validation and ran a full batch that compared each label against
 *  the word "match", reporting a mismatch on every field of every row.
 *
 *  Found by scanning the app's emit points and asking, of each one, whether
 *  anything ever fed it back in. Two of the four were covered by the standing
 *  round-trip harness; this one was not. */

/** The exact header the export writes (components/BatchReview.tsx exportCsv). */
const EXPORT_HEADER = [
  "filename", "overall", "agent_review", "government_warning", "bold_check",
  "brand_name", "class_type", "alcohol_content", "net_contents", "notes",
];

/** The application spreadsheet the batch page actually wants. */
const INPUT_HEADER = [
  "filename", "brand_name", "class_type", "alcohol_content", "net_contents",
];

describe("isResultsExport", () => {
  it("catches this app's own results export", () => {
    expect(isResultsExport(EXPORT_HEADER)).toBe(true);
  });

  it("passes a normal application spreadsheet through", () => {
    expect(isResultsExport(INPUT_HEADER)).toBe(false);
  });

  it("passes the sample spreadsheet's optional columns through", () => {
    expect(isResultsExport([...INPUT_HEADER, "bottler_name_address", "country_of_origin"])).toBe(false);
  });

  it("does not refuse a hand-made sheet whose only odd column is 'overall'", () => {
    // One shared word is not evidence. Refusing here would block a real upload
    // for a spelling coincidence, which is a worse trade than letting it run.
    expect(isResultsExport([...INPUT_HEADER, "overall"])).toBe(false);
  });

  it("still catches the export when a user has deleted the notes column", () => {
    expect(isResultsExport(EXPORT_HEADER.filter((h) => h !== "notes"))).toBe(true);
  });

  it("catches a re-saved export that kept only overall + government_warning", () => {
    expect(isResultsExport(["filename", "overall", "government_warning", "brand_name"])).toBe(true);
  });

  it("is not fooled by an empty header row", () => {
    expect(isResultsExport([])).toBe(false);
  });
});
