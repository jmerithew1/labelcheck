import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

/** Serves the bundled sample batch: batch.csv or an image from
 *  samples/batch/images/. Allowlisted names only. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const isCsv = name === "batch.csv";
  if (!isCsv && !/^[a-z0-9-]+\.png$/.test(name)) {
    return NextResponse.json({ error: "Unknown file." }, { status: 404 });
  }
  const file = isCsv
    ? path.join(process.cwd(), "samples", "batch", "batch.csv")
    : path.join(process.cwd(), "samples", "batch", "images", name);
  if (!fs.existsSync(file)) {
    return NextResponse.json({ error: "Unknown file." }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(fs.readFileSync(file)), {
    headers: {
      "Content-Type": isCsv ? "text/csv" : "image/png",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
