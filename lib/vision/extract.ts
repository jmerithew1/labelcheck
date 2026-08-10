import Anthropic from "@anthropic-ai/sdk";
import {
  EXTRACTION_TOOL,
  EXTRACTION_SYSTEM_PROMPT,
  toLabelExtraction,
  type LabelExtraction,
} from "./contract.ts";

/**
 * Hybrid extraction per the spike gate decision (docs/spike-results.md):
 * - claude-haiku-4-5 runs the full perception extraction (12/12 verbatim
 *   fidelity, p50 3.8s)
 * - claude-sonnet-5 runs a dedicated bold-only stroke-weight judgment in
 *   PARALLEL (16/17 measured accuracy, p50 2.4s)
 * Wall-clock = max of the two. All verdicts stay in lib/compare.
 */

export const EXTRACT_MODEL = "claude-haiku-4-5";
export const BOLD_MODEL = "claude-sonnet-5";

const BOLD_TOOL = {
  name: "record_warning_typography",
  description:
    "Record the typography of the government warning statement's first two words.",
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

export type ExtractionFailure =
  | { kind: "refusal" }
  | { kind: "rate_limited" }
  | { kind: "timeout" }
  | { kind: "api_error"; detail: string };

export type ExtractionOutcome =
  | { ok: true; extraction: LabelExtraction; ms: number }
  | { ok: false; failure: ExtractionFailure; ms: number };

const client = new Anthropic({
  // Spike-measured: real calls p50 3.8s / max 4.4s (Haiku). 30s is loud-failure
  // territory, not a silent hang.
  timeout: 30_000,
  maxRetries: 1,
});

export async function extractLabel(
  imageBase64: string,
  mediaType: "image/png" | "image/jpeg" | "image/webp",
): Promise<ExtractionOutcome> {
  const t0 = performance.now();
  const imageBlock = {
    type: "image" as const,
    source: { type: "base64" as const, media_type: mediaType, data: imageBase64 },
  };

  try {
    const [mainMsg, boldMsg] = await Promise.all([
      client.messages.create({
        model: EXTRACT_MODEL,
        max_tokens: 900,
        system: EXTRACTION_SYSTEM_PROMPT,
        tools: [EXTRACTION_TOOL],
        tool_choice: { type: "tool", name: EXTRACTION_TOOL.name },
        messages: [
          {
            role: "user",
            content: [imageBlock, { type: "text", text: "Record what is printed on this label." }],
          },
        ],
      }),
      client.messages
        .create({
          model: BOLD_MODEL,
          max_tokens: 200,
          tools: [BOLD_TOOL],
          tool_choice: { type: "tool", name: BOLD_TOOL.name },
          messages: [
            {
              role: "user",
              content: [imageBlock, { type: "text", text: "Judge the warning prefix typography." }],
            },
          ],
        })
        // Bold is advisory — its failure degrades to "unclear", never sinks the check.
        .catch(() => null),
    ]);

    const ms = Math.round(performance.now() - t0);

    if (mainMsg.stop_reason === "refusal") {
      return { ok: false, failure: { kind: "refusal" }, ms };
    }
    const tu = mainMsg.content.find((b) => b.type === "tool_use");
    if (!tu || tu.type !== "tool_use") {
      return { ok: false, failure: { kind: "api_error", detail: `no tool_use in response (stop: ${mainMsg.stop_reason})` }, ms };
    }
    const extraction = toLabelExtraction(tu.input as Record<string, unknown>);

    let bold: LabelExtraction["warning_prefix_bold"] = "unclear";
    if (boldMsg) {
      const btu = boldMsg.content.find((b) => b.type === "tool_use");
      if (btu && btu.type === "tool_use") {
        const w = (btu.input as { prefix_weight?: string }).prefix_weight;
        bold = w === "heavier" ? "bold" : w === "same" || w === "lighter" ? "not_bold" : "unclear";
      }
    }
    extraction.warning_prefix_bold = bold;

    return { ok: true, extraction, ms };
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    if (e instanceof Anthropic.APIError) {
      if (e.status === 429) return { ok: false, failure: { kind: "rate_limited" }, ms };
      return { ok: false, failure: { kind: "api_error", detail: `${e.status}: ${e.name}` }, ms };
    }
    if (e instanceof Error && /timeout|timed out/i.test(e.message)) {
      return { ok: false, failure: { kind: "timeout" }, ms };
    }
    return { ok: false, failure: { kind: "api_error", detail: String(e).slice(0, 200) }, ms };
  }
}

/** Human-readable, non-technical error copy (U2). */
export function failureMessage(f: ExtractionFailure): string {
  switch (f.kind) {
    case "refusal":
      return "The AI reader declined to process this image. This usually means the image isn't a product label. Please check the file and try again.";
    case "rate_limited":
      return "The system is briefly at capacity. Wait a few seconds and try again.";
    case "timeout":
      return "Reading this image took too long and was stopped. Try again — if it keeps happening, the image may be too large or the service may be having trouble.";
    case "api_error":
      return "Something went wrong while reading the label. Try again; if it keeps failing, note the time and report the issue.";
  }
}
