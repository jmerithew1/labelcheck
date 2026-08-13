import { NextResponse } from "next/server";
import { locateBands, type LocatableMedia } from "@/lib/vision/locate.ts";
import { rateLimited, RATE_LIMIT_MESSAGE } from "@/lib/rateLimit.ts";

export const maxDuration = 30;

const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_BYTES = 8 * 1024 * 1024;

/** Lazy band lookup for batch detail views: batch runs stay at 2 upstream
 *  calls per label; bands are fetched only when a human opens a row.
 *
 *  Guarded like its siblings: this endpoint spends a paid vision call per
 *  request, and the bold pass fires it once per eligible label, so it is not
 *  the rarely-used lazy path it started as. */
export async function POST(req: Request) {
  if (rateLimited(req)) {
    return NextResponse.json({ error: RATE_LIMIT_MESSAGE }, { status: 429 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Could not read the upload." }, { status: 400 });
  }
  const image = form.get("image");
  if (!(image instanceof File) || !MEDIA_TYPES.has(image.type) || image.size === 0 || image.size > MAX_BYTES) {
    return NextResponse.json({ error: "Send one PNG, JPEG, or WebP image." }, { status: 400 });
  }
  const bytes = Buffer.from(await image.arrayBuffer()).toString("base64");
  const bands = await locateBands(bytes, image.type as LocatableMedia);
  return NextResponse.json({ bands });
}
