import { NextResponse } from "next/server";
import {
  extractLabel,
  failureMessage,
  confirmWarningTranscription,
} from "@/lib/vision/extract.ts";
import { checkWarning } from "@/lib/compare/warning.ts";
import { compareLabel, type ApplicationData } from "@/lib/compare/index.ts";

export const maxDuration = 60;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // downscaled client-side; this is the loud backstop
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

// Prototype abuse guard: the endpoint is public and each call spends real
// API credit. Sliding-window per-IP limit sized so a full-speed 300-label
// batch (8 concurrent, ~2 checks/s) never trips it. In-memory is correct
// here: single container, nothing sensitive stored.
const RATE_LIMIT = 240; // requests per minute per IP
const rateWindow = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (rateWindow.get(ip) ?? []).filter((t) => now - t < 60_000);
  hits.push(now);
  rateWindow.set(ip, hits);
  if (rateWindow.size > 10_000) rateWindow.clear(); // unbounded-growth guard
  return hits.length > RATE_LIMIT;
}

/**
 * POST /api/check — one label against one application.
 * multipart/form-data: image (file), brand_name, class_type, alcohol_content,
 * net_contents, bottler_name_address?, country_of_origin?
 */
export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (rateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many requests from this connection — wait a minute and try again." },
      { status: 429 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Could not read the upload. Please try again." },
      { status: 400 },
    );
  }

  const image = form.get("image");
  if (!(image instanceof File)) {
    return NextResponse.json(
      { error: "No image was attached. Add a label image and try again." },
      { status: 400 },
    );
  }
  if (!MEDIA_TYPES.has(image.type)) {
    return NextResponse.json(
      { error: `"${image.name}" is not a supported image. Use a PNG, JPEG, or WebP file.` },
      { status: 400 },
    );
  }
  if (image.size === 0) {
    return NextResponse.json(
      { error: `"${image.name}" is empty (0 bytes). Check the file and choose it again.` },
      { status: 400 },
    );
  }
  if (image.size > MAX_IMAGE_BYTES) {
    return NextResponse.json(
      { error: `"${image.name}" is too large (over 8 MB). Use a smaller image.` },
      { status: 400 },
    );
  }

  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v : "";
  };
  const app: ApplicationData = {
    brand_name: field("brand_name"),
    class_type: field("class_type"),
    alcohol_content: field("alcohol_content"),
    net_contents: field("net_contents"),
    bottler_name_address: field("bottler_name_address") || undefined,
    country_of_origin: field("country_of_origin") || undefined,
  };
  if (!app.brand_name.trim() && !app.class_type.trim() && !app.alcohol_content.trim() && !app.net_contents.trim()) {
    return NextResponse.json(
      { error: "The application fields are empty. Enter at least one field to check against." },
      { status: 400 },
    );
  }

  const bytes = Buffer.from(await image.arrayBuffer()).toString("base64");
  const outcome = await extractLabel(bytes, image.type as "image/png" | "image/jpeg" | "image/webp");

  if (!outcome.ok) {
    return NextResponse.json(
      { error: failureMessage(outcome.failure), failure: outcome.failure.kind, ms: outcome.ms },
      { status: outcome.failure.kind === "rate_limited" ? 429 : 502 },
    );
  }

  const result = compareLabel(app, outcome.extraction);

  // False-rejection guard: a transcription misread can manufacture a warning
  // failure on a clean label — the costliest error this tool can make. On any
  // text-based warning failure, get a second independent reading from the
  // other model tier; if the two readings disagree on the verdict, downgrade
  // to "check manually" instead of asserting a failure. Only failing labels
  // pay the extra call.
  const v = result.warning.verdict;
  if (v === "fail_wording" || v === "fail_prefix_case") {
    const t0 = performance.now();
    const second = await confirmWarningTranscription(bytes, image.type as "image/png" | "image/jpeg" | "image/webp");
    const confirmMs = Math.round(performance.now() - t0);
    if (second && second.status === "found") {
      const secondCheck = checkWarning({
        status: "found",
        text: second.text,
        boldAdvisory: outcome.extraction.warning_prefix_bold,
        sizeAdvisory: outcome.extraction.warning_text_size,
      });
      if (secondCheck.verdict === "pass" || secondCheck.verdict === "pass_formatting_note") {
        result.warning = {
          ...result.warning,
          verdict: "unreadable",
          notes: [
            "Two independent AI readings of the warning disagree — the first found a deviation, the second reads it as exact. This is usually a transcription artifact, not a label defect. Check the warning on the image before acting.",
            ...result.warning.notes,
          ],
        };
        if (result.overall === "warning_failure") result.overall = "needs_review";
      } else {
        result.warning.notes = [
          "Confirmed by a second independent AI reading.",
          ...result.warning.notes,
        ];
      }
    }
    return NextResponse.json({
      result,
      extraction: outcome.extraction,
      ms: outcome.ms + confirmMs,
    });
  }

  return NextResponse.json({ result, extraction: outcome.extraction, ms: outcome.ms });
}
