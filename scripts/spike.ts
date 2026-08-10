/**
 * Phase 0b spike: transcription fidelity, latency, burst, bold accuracy, injection.
 * Run: node scripts/spike.ts            (Node 24 strips types natively)
 * Requires ANTHROPIC_API_KEY in env. Writes docs/spike-results.md + .json.
 *
 * Caps (mechanical, per plan): one prompt variant per run, max 3 variants total
 * across the whole spike; burst limited to BURST_N calls; hard MAX_CALLS guard.
 */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  EXTRACTION_TOOL,
  EXTRACTION_SYSTEM_PROMPT,
  toLabelExtraction,
} from "../lib/vision/contract.ts";

const MODELS = ["claude-sonnet-5", "claude-haiku-4-5"] as const;
const BURST_N = 25;
const BURST_MODEL = "claude-sonnet-5";
const MAX_CALLS = 120; // hard spend guard for the whole spike
let calls = 0;

const root = path.join(import.meta.dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "samples", "manifest.json"), "utf8"),
);
const client = new Anthropic({ timeout: 60_000, maxRetries: 1 });

interface LabelEntry {
  name: string;
  png: string;
  json: string;
  spike_case?: string;
}

function sidecar(entry: LabelEntry) {
  return JSON.parse(fs.readFileSync(path.join(root, entry.json), "utf8"));
}

function imageBlock(entry: LabelEntry) {
  const data = fs.readFileSync(path.join(root, entry.png)).toString("base64");
  return {
    type: "image" as const,
    source: { type: "base64" as const, media_type: "image/png" as const, data },
  };
}

async function extract(model: string, entry: LabelEntry) {
  if (++calls > MAX_CALLS) throw new Error("MAX_CALLS spike guard hit");
  const t0 = performance.now();
  const msg = await client.messages.create({
    model,
    max_tokens: 900,
    system: EXTRACTION_SYSTEM_PROMPT,
    tools: [EXTRACTION_TOOL],
    tool_choice: { type: "tool", name: EXTRACTION_TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          imageBlock(entry),
          { type: "text", text: "Record what is printed on this label." },
        ],
      },
    ],
  });
  const ms = Math.round(performance.now() - t0);
  const tu = msg.content.find((b) => b.type === "tool_use");
  if (!tu || tu.type !== "tool_use") {
    return { ms, stop: msg.stop_reason, extraction: null };
  }
  return { ms, stop: msg.stop_reason, extraction: toLabelExtraction(tu.input as Record<string, unknown>) };
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

async function main() {
  const labels: LabelEntry[] = manifest.labels;
  const byName = new Map(labels.map((l) => [l.name, l]));
  const fidelityCases = [
    "clean-match", "title-case-prefix", "word-swap", "word-drop",
    "punct-drift", "allcaps-body", "non-bold-prefix", "missing-warning",
    "case-diff", "wine-label", "injection", "small-warning",
  ].map((n) => byName.get(n)).filter(Boolean) as LabelEntry[];
  const boldCases = labels.filter((l) => {
    const sc = sidecar(l);
    return typeof sc.warning_prefix_bold === "boolean" && sc.warning_text_verbatim;
  });

  const results: Record<string, unknown>[] = [];
  for (const model of MODELS) {
    console.log(`\n=== ${model} — fidelity + latency (${fidelityCases.length} cases) ===`);
    for (const entry of fidelityCases) {
      const sc = sidecar(entry);
      try {
        const r = await extract(model, entry);
        const got = r.extraction;
        const wantWarning: string = sc.warning_text_verbatim ?? "";
        const gotWarning = got ? norm(got.warning.text) : "";
        const verbatimOk = wantWarning
          ? gotWarning === norm(wantWarning)
          : got?.warning.status === "absent";
        const row = {
          model, case: entry.name, ms: r.ms, stop: r.stop,
          warning_verbatim_ok: verbatimOk,
          warning_status: got?.warning.status,
          bold_read: got?.warning_prefix_bold,
          bold_truth: sc.warning_prefix_bold,
          brand_read: got?.brand_name.text,
          brand_truth: sc.brand_name,
          got_warning: gotWarning,
          want_warning: norm(wantWarning),
        };
        results.push(row);
        console.log(
          `${entry.name}: ${r.ms}ms verbatim=${verbatimOk ? "OK" : "MISS"} bold=${row.bold_read}/${row.bold_truth}`,
        );
        if (!verbatimOk && wantWarning) {
          console.log(`  want: ${norm(wantWarning).slice(0, 120)}...`);
          console.log(`  got : ${gotWarning.slice(0, 120)}...`);
        }
      } catch (e) {
        results.push({ model, case: entry.name, error: String(e) });
        console.log(`${entry.name}: ERROR ${e}`);
      }
    }
  }

  // Bold accuracy on Sonnet across all ground-truthed labels (n >= 10)
  console.log(`\n=== bold accuracy — ${BURST_MODEL} (${boldCases.length} labels) ===`);
  let boldRight = 0, boldTotal = 0, boldUnclear = 0;
  for (const entry of boldCases) {
    const sc = sidecar(entry);
    try {
      const r = await extract(BURST_MODEL, entry);
      const read = r.extraction?.warning_prefix_bold;
      boldTotal++;
      if (read === "unclear") boldUnclear++;
      else if ((read === "bold") === Boolean(sc.warning_prefix_bold)) boldRight++;
      results.push({ model: BURST_MODEL, case: `bold:${entry.name}`, bold_read: read, bold_truth: sc.warning_prefix_bold, ms: r.ms });
      console.log(`${entry.name}: read=${read} truth=${sc.warning_prefix_bold}`);
    } catch (e) {
      console.log(`${entry.name}: ERROR ${e}`);
    }
  }

  // Burst: BURST_N concurrent calls
  console.log(`\n=== burst — ${BURST_N} concurrent on ${BURST_MODEL} ===`);
  const burstEntry = byName.get("clean-match")!;
  const t0 = performance.now();
  const burst = await Promise.allSettled(
    Array.from({ length: BURST_N }, () => extract(BURST_MODEL, burstEntry)),
  );
  const burstWall = Math.round(performance.now() - t0);
  const ok = burst.filter((b) => b.status === "fulfilled").length;
  const errs = burst
    .filter((b): b is PromiseRejectedResult => b.status === "rejected")
    .map((b) => String(b.reason).slice(0, 100));
  const rateLimited = errs.filter((e) => /429|rate/i.test(e)).length;
  console.log(`burst: ${ok}/${BURST_N} ok, ${rateLimited} rate-limited, wall ${burstWall}ms`);

  // Summarize
  const summary = {
    ran_at: new Date().toISOString(),
    fidelity: MODELS.map((m) => {
      const rows = results.filter((r) => r.model === m && !String(r.case).startsWith("bold:") && !r.error);
      const lat = rows.map((r) => r.ms as number).sort((a, b) => a - b);
      return {
        model: m,
        cases: rows.length,
        verbatim_ok: rows.filter((r) => r.warning_verbatim_ok).length,
        p50_ms: lat[Math.floor(lat.length / 2)] ?? null,
        max_ms: lat[lat.length - 1] ?? null,
      };
    }),
    bold: { total: boldTotal, correct: boldRight, unclear: boldUnclear },
    burst: { n: BURST_N, ok, rate_limited: rateLimited, wall_ms: burstWall, errors: errs.slice(0, 5) },
    total_calls: calls,
  };
  fs.writeFileSync(path.join(root, "docs", "spike-results.json"), JSON.stringify({ summary, results }, null, 2));
  console.log("\n=== SUMMARY ===\n" + JSON.stringify(summary, null, 2));
  console.log("\nWritten to docs/spike-results.json — analyze + write docs/spike-results.md next.");
}

main().catch((e) => { console.error(e); process.exit(1); });
