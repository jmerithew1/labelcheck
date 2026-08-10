/**
 * Measures extraction fidelity + verdict correctness on the DEGRADED label
 * set (blur / perspective tilt / glare) — the honest approximation of
 * imperfect photos, since no physical bottles exist to photograph.
 * Run: node scripts/degraded-fidelity.ts   (after samples/tools/degrade.mjs)
 * Writes docs/degraded-fidelity.json.
 */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  EXTRACTION_TOOL,
  EXTRACTION_SYSTEM_PROMPT,
  toLabelExtraction,
} from "../lib/vision/contract.ts";
import { checkWarning } from "../lib/compare/warning.ts";

const MODEL = "claude-haiku-4-5"; // production extraction model
const root = path.join(import.meta.dirname, "..");
const degradedDir = path.join(root, "samples", "degraded");
const labelsDir = path.join(root, "samples", "labels");

const client = new Anthropic({ timeout: 60_000, maxRetries: 1 });
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

async function main() {
  const files = fs.readdirSync(degradedDir).filter((f) => f.endsWith(".png"));
  const rows: Record<string, unknown>[] = [];
  let verbatimOk = 0, verdictOk = 0, unreadable = 0;

  for (const file of files) {
    const base = file.split("--")[0];
    const sc = JSON.parse(fs.readFileSync(path.join(labelsDir, `${base}.json`), "utf8"));
    const data = fs.readFileSync(path.join(degradedDir, file)).toString("base64");
    const t0 = performance.now();
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 900,
      system: EXTRACTION_SYSTEM_PROMPT,
      tools: [EXTRACTION_TOOL],
      tool_choice: { type: "tool", name: EXTRACTION_TOOL.name },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data } },
            { type: "text", text: "Record what is printed on this label." },
          ],
        },
      ],
    });
    const ms = Math.round(performance.now() - t0);
    const tu = msg.content.find((b) => b.type === "tool_use");
    if (!tu || tu.type !== "tool_use") {
      rows.push({ file, error: `no tool_use (${msg.stop_reason})`, ms });
      continue;
    }
    const ex = toLabelExtraction(tu.input as Record<string, unknown>);

    const wantWarning: string = sc.warning_text_verbatim ?? "";
    const gotVerbatim = wantWarning
      ? norm(ex.warning.text) === norm(wantWarning)
      : ex.warning.status === "absent";
    if (gotVerbatim) verbatimOk++;
    if (ex.warning.status === "unreadable") unreadable++;

    // Verdict correctness: what the deterministic check concludes from this
    // read vs what it concludes from ground truth. "unreadable" counts as a
    // correct degradation (manual check), never as a wrong verdict.
    const got = checkWarning({ status: ex.warning.status, text: ex.warning.text, boldAdvisory: "bold" });
    const want = checkWarning({
      status: wantWarning ? "found" : "absent",
      text: wantWarning,
      boldAdvisory: "bold",
    });
    const verdictMatches = got.verdict === want.verdict || got.verdict === "unreadable";
    if (verdictMatches) verdictOk++;

    rows.push({
      file, ms,
      warning_status: ex.warning.status,
      verbatim_ok: gotVerbatim,
      verdict_got: got.verdict,
      verdict_want: want.verdict,
      verdict_ok: verdictMatches,
      brand_read: ex.brand_name.text,
    });
    console.log(
      `${file}: ${ms}ms verbatim=${gotVerbatim ? "OK" : "MISS"} verdict=${got.verdict}${verdictMatches ? "" : ` (want ${want.verdict})`}`,
    );
  }

  const summary = {
    measured_at: new Date().toISOString(),
    model: MODEL,
    n: rows.length,
    warning_verbatim_ok: verbatimOk,
    verdict_ok: verdictOk,
    degraded_to_unreadable: unreadable,
  };
  fs.writeFileSync(
    path.join(root, "docs", "degraded-fidelity.json"),
    JSON.stringify({ summary, rows }, null, 2),
  );
  console.log("\n" + JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
