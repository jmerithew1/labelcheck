import Anthropic from "@anthropic-ai/sdk";

/**
 * Field locator: approximate vertical BANDS (not boxes) for evidence
 * highlighting. Spike-validated (scripts/spike-locate-v2.ts): 20/20 bands
 * parse, p50 2.0s — faster than the main extraction call, so running it in
 * parallel adds zero wall-clock. Bands are approximate by design: the UI pads
 * them ±2.5% and labels them "approximate location"; x-precision was measured
 * too sloppy to show (v1), so full-width bands only. Best-effort: any failure
 * returns {} and the UI simply shows no highlight.
 */

export const LOCATE_MODEL = "claude-haiku-4-5";

export const BAND_FIELDS = [
  "brand_name", "class_type", "alcohol_content", "net_contents", "warning",
] as const;
export type BandField = (typeof BAND_FIELDS)[number];

/** top/bottom in 0-1000 image-height units */
export type Band = [number, number];
export type Bands = Partial<Record<BandField, Band>>;

const BAND_TOOL = {
  name: "record_field_bands",
  description:
    "Record the vertical position of each text element on this label image. Work top to bottom: for each element, first re-read its exact printed text, then record the vertical band that text occupies.",
  input_schema: {
    type: "object" as const,
    properties: Object.fromEntries(
      BAND_FIELDS.map((f) => [
        `${f}_band`,
        {
          type: "string",
          description:
            `Vertical band of the ${f.replace(/_/g, " ")} text as "top,bottom" — two integers 0-1000 where 0 is the image's top edge and 1000 its bottom edge. The band must contain every line of that specific text (for the warning: the whole statement block). Empty string ONLY if the element is truly absent from the label.`,
        },
      ]),
    ),
    required: BAND_FIELDS.map((f) => `${f}_band`),
  },
};

function parseBand(s: unknown): Band | null {
  const m = typeof s === "string" ? s.match(/^(\d+),\s*(\d+)$/) : null;
  if (!m) return null;
  const [a, b] = m.slice(1).map(Number);
  if (b <= a || b > 1000) return null;
  return [a, b];
}

const client = new Anthropic({ timeout: 30_000, maxRetries: 1 });

export type LocatableMedia = "image/png" | "image/jpeg" | "image/webp";

export async function locateBands(
  imageBase64: string,
  mediaType: LocatableMedia,
): Promise<Bands> {
  try {
    const msg = await client.messages.create({
      model: LOCATE_MODEL,
      max_tokens: 300,
      tools: [BAND_TOOL],
      tool_choice: { type: "tool", name: BAND_TOOL.name },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text: "Record the vertical band of each element." },
        ],
      }],
    });
    const tu = msg.content.find((b) => b.type === "tool_use");
    if (!tu || tu.type !== "tool_use") return {};
    const raw = tu.input as Record<string, unknown>;
    const bands: Bands = {};
    for (const f of BAND_FIELDS) {
      const band = parseBand(raw[`${f}_band`]);
      if (band) bands[f] = band;
    }
    return bands;
  } catch {
    return {};
  }
}
