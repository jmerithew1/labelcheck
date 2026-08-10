import { NextResponse } from "next/server";
import { extractLabel, failureMessage } from "@/lib/vision/extract.ts";
import { compareLabel, type ApplicationData } from "@/lib/compare/index.ts";

export const maxDuration = 60;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // downscaled client-side; this is the loud backstop
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * POST /api/check — one label against one application.
 * multipart/form-data: image (file), brand_name, class_type, alcohol_content,
 * net_contents, bottler_name_address?, country_of_origin?
 */
export async function POST(req: Request) {
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
  return NextResponse.json({ result, extraction: outcome.extraction, ms: outcome.ms });
}
