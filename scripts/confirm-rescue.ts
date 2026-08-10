/** Does the shipped two-reading pipeline rescue the degraded false-fails?
 *  Runs the Sonnet confirmation read on the three degraded images where the
 *  Haiku read produced a false warning-failure. Appends to degraded-fidelity.json. */
import fs from "node:fs";
import path from "node:path";
import { confirmWarningTranscription } from "../lib/vision/extract.ts";
import { checkWarning } from "../lib/compare/warning.ts";

const root = path.join(import.meta.dirname, "..");
const FALSE_FAILS = ["small-warning--tilt.png", "wine-label--blur.png", "wine-label--glare.png"];

async function main() {
  const results: Record<string, unknown>[] = [];
  for (const file of FALSE_FAILS) {
    const data = fs.readFileSync(path.join(root, "samples", "degraded", file)).toString("base64");
    const second = await confirmWarningTranscription(data, "image/png");
    if (!second) {
      results.push({ file, rescued: false, reason: "confirm call failed" });
      continue;
    }
    const check = checkWarning({ status: second.status, text: second.text, boldAdvisory: "bold" });
    const rescued = check.verdict === "pass" || check.verdict === "pass_formatting_note";
    results.push({ file, second_status: second.status, second_verdict: check.verdict, rescued });
    console.log(`${file}: second read → ${check.verdict} — ${rescued ? "RESCUED (downgrades to check-manually)" : "not rescued"}`);
  }
  const existing = JSON.parse(fs.readFileSync(path.join(root, "docs", "degraded-fidelity.json"), "utf8"));
  existing.confirmation_rescue = results;
  fs.writeFileSync(path.join(root, "docs", "degraded-fidelity.json"), JSON.stringify(existing, null, 2));
  console.log("appended to docs/degraded-fidelity.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
