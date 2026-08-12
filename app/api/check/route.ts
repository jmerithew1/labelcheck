import { NextResponse } from "next/server";
import {
  extractLabel,
  failureMessage,
  confirmWarningTranscription,
  type ExtractableMedia,
} from "@/lib/vision/extract.ts";
import { locateBands, type LocatableMedia, type Bands } from "@/lib/vision/locate.ts";
import { applySecondReading } from "@/lib/compare/warning.ts";
import { compareLabel, type ApplicationData } from "@/lib/compare/index.ts";

export const maxDuration = 60;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // images are downscaled client-side; this is the loud backstop
const MAX_PDF_BYTES = 10 * 1024 * 1024; // PDFs can't be downscaled in-browser
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);

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
      { error: `"${image.name}" is not a supported file. Use a PNG, JPEG, WebP, or PDF.` },
      { status: 400 },
    );
  }
  if (image.size === 0) {
    return NextResponse.json(
      { error: `"${image.name}" is empty (0 bytes). Check the file and choose it again.` },
      { status: 400 },
    );
  }
  const isPdf = image.type === "application/pdf";
  const maxBytes = isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
  if (image.size > maxBytes) {
    return NextResponse.json(
      { error: `"${image.name}" is too large (over ${Math.round(maxBytes / 1024 / 1024)} MB). Use a smaller file.` },
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
  const media = image.type as ExtractableMedia;

  // Evidence bands run as a THIRD parallel call (spike: p50 2.0s < the main
  // call's 3.8s → zero added wall-clock). Batch rows send skip_locate=1 to
  // stay at 2 upstream calls/label; their detail view fetches bands lazily
  // via /api/locate. PDFs skip bands (locator is image-only).
  const wantBands = form.get("skip_locate") !== "1" && !isPdf;
  const [outcome, bands]: [Awaited<ReturnType<typeof extractLabel>>, Bands] = await Promise.all([
    extractLabel(bytes, media),
    wantBands ? locateBands(bytes, media as LocatableMedia) : Promise.resolve({}),
  ]);

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
  // fail_missing is included deliberately: "this label has no government
  // warning" is the most consequential claim the tool makes, and on a dark,
  // torn or heavily compressed photo it is exactly the claim a single read
  // gets wrong (measured: docs/degraded-hard.json).
  const v = result.warning.verdict;
  if (v === "fail_wording" || v === "fail_prefix_case" || v === "fail_missing") {
    // Async mode (single-check UI): return the provisional verdict now so
    // every label answers in ~5s; the client runs the confirmation through
    // /api/confirm and updates the warning row in place. Batch rows omit the
    // flag and keep the blocking confirmation (nobody watches a single row).
    if (form.get("async_confirm") === "1") {
      return NextResponse.json({
        result,
        extraction: outcome.extraction,
        bands,
        ms: outcome.ms,
        confirm_pending: true,
      });
    }
    const t0 = performance.now();
    const second = await confirmWarningTranscription(bytes, media);
    const confirmMs = Math.round(performance.now() - t0);
    const applied = applySecondReading(result.warning, result.overall, second, {
      boldAdvisory: outcome.extraction.warning_prefix_bold,
      sizeAdvisory: outcome.extraction.warning_text_size,
    });
    result.warning = applied.warning;
    result.overall = applied.overall;
    return NextResponse.json({
      result,
      extraction: outcome.extraction,
      bands,
      ms: outcome.ms + confirmMs,
    });
  }

  return NextResponse.json({ result, extraction: outcome.extraction, bands, ms: outcome.ms });
}
