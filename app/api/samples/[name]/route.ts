import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

/** Serves bundled sample label images. Name is allowlisted to files that
 *  actually exist under samples/labels — no path traversal. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!/^[a-z0-9-]+\.png$/.test(name)) {
    return NextResponse.json({ error: "Unknown sample." }, { status: 404 });
  }
  const file = path.join(process.cwd(), "samples", "labels", name);
  if (!fs.existsSync(file)) {
    return NextResponse.json({ error: "Unknown sample." }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(fs.readFileSync(file)), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
