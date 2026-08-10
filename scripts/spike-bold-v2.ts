/**
 * Spike prompt variant 2 (of max 3): can Haiku's bold-prefix judgment be fixed
 * with a sharper instruction? Haiku v1 read "bold" for every prefix (2/2 non-bold
 * cases wrong). Runs Haiku only, bold-relevant labels only.
 */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.SPIKE_MODEL ?? "claude-haiku-4-5";
const root = path.join(import.meta.dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "samples", "manifest.json"), "utf8"),
);
const client = new Anthropic({ timeout: 60_000, maxRetries: 1 });

const BOLD_TOOL = {
  name: "record_warning_typography",
  description: "Record the typography of the government warning statement's first two words.",
  input_schema: {
    type: "object" as const,
    properties: {
      prefix_weight: {
        type: "string",
        enum: ["heavier", "same", "lighter", "no_warning_present"],
        description:
          "Compare the STROKE THICKNESS of the letters in the warning statement's first two words against the stroke thickness of the rest of the warning paragraph on the same label. 'heavier' only if the strokes are visibly thicker (bold). ALL-CAPS or larger size alone is NOT heavier — judge stroke weight only.",
      },
    },
    required: ["prefix_weight"],
  },
};

async function main() {
  const labels = manifest.labels.filter((l: { ground_truth: string }) => {
    const sc = JSON.parse(fs.readFileSync(path.join(root, l.ground_truth), "utf8"));
    return typeof sc.warning_prefix_bold === "boolean" && sc.warning_text_verbatim;
  });
  let right = 0;
  const rows: unknown[] = [];
  for (const entry of labels) {
    const sc = JSON.parse(fs.readFileSync(path.join(root, entry.ground_truth), "utf8"));
    const data = fs.readFileSync(path.join(root, entry.png)).toString("base64");
    const t0 = performance.now();
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      tools: [BOLD_TOOL],
      tool_choice: { type: "tool", name: BOLD_TOOL.name },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data } },
            { type: "text", text: "Judge the warning prefix typography." },
          ],
        },
      ],
    });
    const ms = Math.round(performance.now() - t0);
    const tu = msg.content.find((b) => b.type === "tool_use");
    const weight = tu && tu.type === "tool_use" ? (tu.input as { prefix_weight: string }).prefix_weight : "?";
    const readBold = weight === "heavier";
    const ok = readBold === Boolean(sc.warning_prefix_bold);
    if (ok) right++;
    rows.push({ label: entry.name, weight, truth: sc.warning_prefix_bold, ok, ms });
    console.log(`${entry.name}: weight=${weight} truth=${sc.warning_prefix_bold} ${ok ? "OK" : "MISS"} (${ms}ms)`);
  }
  console.log(`\nvariant-2 bold accuracy (haiku): ${right}/${labels.length}`);
  fs.writeFileSync(
    path.join(root, "docs", "spike-bold-v2.json"),
    JSON.stringify({ model: MODEL, variant: 2, right, total: labels.length, rows }, null, 2),
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
