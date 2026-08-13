import { NextResponse } from "next/server";
import { confirmWarningTranscription, type ExtractableMedia } from "@/lib/vision/extract.ts";
import { applySecondReading, type OverallVerdict } from "@/lib/compare/warning.ts";
import type { WarningResult } from "@/lib/compare/types.ts";
import { rateLimited, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit.ts";

export const maxDuration = 30;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);

const OVERALLS = new Set<OverallVerdict>(["clean", "needs_review", "warning_failure", "not_a_label"]);
const VERDICTS = new Set(["pass", "pass_formatting_note", "fail_wording", "fail_prefix_case", "fail_missing", "unreadable"]);
const BOLD = new Set(["bold", "not_bold", "unclear"]);
const SIZE = new Set(["normal", "small", "illegibly_small"]);

/**
 * POST /api/confirm — the second independent warning reading, split out of
 * /api/check so the single-check UI can show a provisional verdict in ~5s
 * and update it in place. Stateless: the client re-sends the (downscaled)
 * image plus the provisional warning result it already holds.
 * multipart/form-data: image (file), warning (JSON of WarningResult),
 * overall, bold_advisory, size_advisory?
 */
export async function POST(req: Request) {
  if (rateLimited(req)) {
    return NextResponse.json({ error: RATE_LIMIT_MESSAGE }, { status: 429 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Could not read the request. Please try again." }, { status: 400 });
  }

  const image = form.get("image");
  if (!(image instanceof File) || !MEDIA_TYPES.has(image.type) || image.size === 0) {
    return NextResponse.json({ error: "A valid label image is required." }, { status: 400 });
  }
  if (image.size > (image.type === "application/pdf" ? MAX_PDF_BYTES : MAX_IMAGE_BYTES)) {
    return NextResponse.json({ error: "The image is too large." }, { status: 400 });
  }

  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v : "";
  };

  let warning: WarningResult;
  try {
    warning = JSON.parse(field("warning"));
    if (
      !VERDICTS.has(warning?.verdict) ||
      !Array.isArray(warning?.notes) ||
      !warning.notes.every((n) => typeof n === "string")
    ) throw new Error();
  } catch {
    return NextResponse.json({ error: "The provisional warning result is missing or malformed." }, { status: 400 });
  }
  const overall = field("overall") as OverallVerdict;
  if (!OVERALLS.has(overall)) {
    return NextResponse.json({ error: "The provisional overall verdict is missing or malformed." }, { status: 400 });
  }
  const boldRaw = field("bold_advisory");
  const boldAdvisory = (BOLD.has(boldRaw) ? boldRaw : "unclear") as "bold" | "not_bold" | "unclear";
  const sizeRaw = field("size_advisory");
  const sizeAdvisory = SIZE.has(sizeRaw) ? (sizeRaw as "normal" | "small" | "illegibly_small") : undefined;

  const bytes = Buffer.from(await image.arrayBuffer()).toString("base64");
  const t0 = performance.now();
  const second = await confirmWarningTranscription(bytes, image.type as ExtractableMedia);
  const ms = Math.round(performance.now() - t0);

  const applied = applySecondReading(warning, overall, second, { boldAdvisory, sizeAdvisory });
  return NextResponse.json({
    warning: applied.warning,
    overall: applied.overall,
    outcome: applied.outcome,
    ms,
  });
}
