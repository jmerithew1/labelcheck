/**
 * Locator variant 2 (of max 3): horizontal BANDS instead of boxes.
 * Full-width soft highlights kill x-error; padding absorbs one-line error.
 * Run: node scripts/spike-locate-v2.ts
 */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-4-5";
const root = path.join(import.meta.dirname, "..");
const client = new Anthropic({ timeout: 30_000, maxRetries: 1 });

const FIELDS = ["brand_name", "class_type", "alcohol_content", "net_contents", "warning"] as const;

const BAND_TOOL = {
  name: "record_field_bands",
  description:
    "Record the vertical position of each text element on this label image. Work top to bottom: for each element, first re-read its exact printed text, then record the vertical band that text occupies.",
  input_schema: {
    type: "object" as const,
    properties: Object.fromEntries(
      FIELDS.map((f) => [
        `${f}_band`,
        {
          type: "string",
          description:
            `Vertical band of the ${f.replace(/_/g, " ")} text as "top,bottom" — two integers 0-1000 where 0 is the image's top edge and 1000 its bottom edge. The band must contain every line of that specific text (for the warning: the whole statement block). Empty string ONLY if the element is truly absent from the label.`,
        },
      ]),
    ),
    required: FIELDS.map((f) => `${f}_band`),
  },
};

function parseBand(s: string): [number, number] | null {
  const m = (s ?? "").match(/^(\d+),\s*(\d+)$/);
  if (!m) return null;
  const [a, b] = m.slice(1).map(Number);
  if (b <= a || b > 1000) return null;
  return [a, b];
}

async function main() {
  const files = ["clean-match.png", "wine-label.png", "stones-throw.png", "title-case-prefix.png"];
  const outDir = path.join(root, "samples", "tools", "locate-preview");
  const latencies: number[] = [];
  const COLORS: Record<string, string> = {
    brand_name: "#2563EB", class_type: "#7C3AED", alcohol_content: "#D97706",
    net_contents: "#0D9488", warning: "#DC2626",
  };

  for (const file of files) {
    const data = fs.readFileSync(path.join(root, "samples", "labels", file)).toString("base64");
    const t0 = performance.now();
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      tools: [BAND_TOOL],
      tool_choice: { type: "tool", name: BAND_TOOL.name },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data } },
          { type: "text", text: "Record the vertical band of each element." },
        ],
      }],
    });
    const ms = Math.round(performance.now() - t0);
    latencies.push(ms);
    const tu = msg.content.find((b) => b.type === "tool_use");
    const raw = tu && tu.type === "tool_use" ? (tu.input as Record<string, string>) : {};
    const bands = Object.fromEntries(FIELDS.map((f) => [f, parseBand(raw[`${f}_band`])]));
    const overlays = Object.entries(bands)
      .filter(([, b]) => b)
      .map(([f, b]) => {
        const [t, btm] = b as [number, number];
        return `<div style="position:absolute;left:0;top:${t / 10}%;width:100%;height:${(btm - t) / 10}%;background:${COLORS[f]}22;border-top:2px solid ${COLORS[f]};border-bottom:2px solid ${COLORS[f]};box-sizing:border-box;"></div>
        <span style="position:absolute;right:0;top:${t / 10}%;background:${COLORS[f]};color:#fff;font:11px sans-serif;padding:1px 5px;">${f}</span>`;
      })
      .join("");
    fs.writeFileSync(
      path.join(outDir, file.replace(".png", "-band.html")),
      `<div style="position:relative;display:inline-block;"><img src="data:image/png;base64,${data}" style="display:block;max-width:740px;"/>${overlays}</div>`,
    );
    console.log(`${file}: ${ms}ms — ${FIELDS.map((f) => `${f}=${bands[f] ? bands[f]!.join("-") : "MISS"}`).join(" ")}`);
  }
  latencies.sort((a, b) => a - b);
  console.log(`latency p50 ${latencies[Math.floor(latencies.length / 2)]}ms max ${latencies[latencies.length - 1]}ms`);
}

main().catch((e) => { console.error(e); process.exit(1); });
