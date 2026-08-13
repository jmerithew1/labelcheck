import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

/** Serves bundled sample label images. Name is allowlisted to files that
 *  actually exist under samples/demo or samples/labels — no path traversal.
 *
 *  Two directories, checked in order. samples/demo holds the degraded demo
 *  images the cards actually serve (drawn from the measured degradation
 *  corpus); samples/labels stays the canonical pristine template set, which
 *  scripts/check-doc-counts.mjs counts and samples/manifest.json describes.
 *  Mixing the two would inflate the documented label count with variants that
 *  are not new labels. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!/^[a-z0-9-]+\.png$/.test(name)) {
    return NextResponse.json({ error: "Unknown sample." }, { status: 404 });
  }
  const roots = ["demo", "labels"];
  const file = roots
    .map((dir) => path.join(process.cwd(), "samples", dir, name))
    .find((p) => fs.existsSync(p));
  if (!file) {
    return NextResponse.json({ error: "Unknown sample." }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(fs.readFileSync(file)), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
