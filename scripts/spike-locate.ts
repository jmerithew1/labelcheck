/**
 * Locator spike: can Haiku return usable approximate regions for label fields
 * as a small parallel call, and at what latency?
 * Run: node scripts/spike-locate.ts → prints latency + writes annotated HTML
 * previews to samples/tools/locate-preview/ for visual inspection.
 */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-4-5";
const root = path.join(import.meta.dirname, "..");
const client = new Anthropic({ timeout: 30_000, maxRetries: 1 });

const LOCATE_TOOL = {
  name: "record_field_locations",
  description: "Record where each element sits on this label image.",
  input_schema: {
    type: "object" as const,
    properties: Object.fromEntries(
      ["brand_name", "class_type", "alcohol_content", "net_contents", "warning"].flatMap((f) => [
        [`${f}_box`, {
          type: "string",
          description:
            `Bounding region of the ${f.replace(/_/g, " ")} text as "x0,y0,x1,y1" — integers 0-1000 where (0,0) is top-left and (1000,1000) is bottom-right of the image. Empty string if not present.`,
        }],
      ]),
    ),
    required: ["brand_name_box", "class_type_box", "alcohol_content_box", "net_contents_box", "warning_box"],
  },
};

function parseBox(s: string): number[] | null {
  const m = s.match(/^(\d+),\s*(\d+),\s*(\d+),\s*(\d+)$/);
  if (!m) return null;
  const [x0, y0, x1, y1] = m.slice(1).map(Number);
  if (x1 <= x0 || y1 <= y0 || x1 > 1000 || y1 > 1000) return null;
  return [x0, y0, x1, y1];
}

async function locate(file: string) {
  const data = fs.readFileSync(path.join(root, "samples", "labels", file)).toString("base64");
  const t0 = performance.now();
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    tools: [LOCATE_TOOL],
    tool_choice: { type: "tool", name: LOCATE_TOOL.name },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data } },
        { type: "text", text: "Record the location of each element on this label." },
      ],
    }],
  });
  const ms = Math.round(performance.now() - t0);
  const tu = msg.content.find((b) => b.type === "tool_use");
  const raw = tu && tu.type === "tool_use" ? (tu.input as Record<string, string>) : {};
  const boxes: Record<string, number[] | null> = {};
  for (const f of ["brand_name", "class_type", "alcohol_content", "net_contents", "warning"]) {
    boxes[f] = parseBox(raw[`${f}_box`] ?? "");
  }
  return { ms, boxes };
}

const COLORS: Record<string, string> = {
  brand_name: "#2563EB", class_type: "#7C3AED", alcohol_content: "#D97706",
  net_contents: "#0D9488", warning: "#DC2626",
};

async function main() {
  const files = ["clean-match.png", "wine-label.png", "stones-throw.png", "title-case-prefix.png"];
  const outDir = path.join(root, "samples", "tools", "locate-preview");
  fs.mkdirSync(outDir, { recursive: true });
  const latencies: number[] = [];
  let sane = 0, total = 0;

  for (const file of files) {
    const { ms, boxes } = await locate(file);
    latencies.push(ms);
    // Sanity heuristics: warning near bottom, brand in top half, boxes parseable.
    for (const [f, b] of Object.entries(boxes)) {
      total++;
      if (!b) continue;
      if (f === "warning" && b[1] < 500) continue; // warning should start in lower half
      if (f === "brand_name" && b[1] > 500) continue; // brand should start in upper half
      sane++;
    }
    const b64 = fs.readFileSync(path.join(root, "samples", "labels", file)).toString("base64");
    const overlays = Object.entries(boxes)
      .filter(([, b]) => b)
      .map(([f, b]) => {
        const [x0, y0, x1, y1] = b!;
        return `<div style="position:absolute;left:${x0 / 10}%;top:${y0 / 10}%;width:${(x1 - x0) / 10}%;height:${(y1 - y0) / 10}%;border:3px solid ${COLORS[f]};border-radius:4px;box-sizing:border-box;" title="${f}"></div>
        <span style="position:absolute;left:${x0 / 10}%;top:${y0 / 10}%;transform:translateY(-100%);background:${COLORS[f]};color:#fff;font:11px sans-serif;padding:1px 5px;">${f}</span>`;
      })
      .join("");
    fs.writeFileSync(
      path.join(outDir, file.replace(".png", ".html")),
      `<div style="position:relative;display:inline-block;"><img src="data:image/png;base64,${b64}" style="display:block;max-width:740px;"/>${overlays}</div>`,
    );
    console.log(`${file}: ${ms}ms — boxes: ${Object.entries(boxes).map(([f, b]) => `${f}=${b ? "ok" : "MISS"}`).join(" ")}`);
  }
  latencies.sort((a, b) => a - b);
  console.log(`\nlatency p50 ${latencies[Math.floor(latencies.length / 2)]}ms max ${latencies[latencies.length - 1]}ms`);
  console.log(`sanity: ${sane}/${total} boxes parse + pass position heuristics`);
  console.log(`previews: samples/tools/locate-preview/*.html`);
}

main().catch((e) => { console.error(e); process.exit(1); });
