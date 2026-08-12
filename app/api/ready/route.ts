import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

// Readiness: asserts the runtime actually has what it needs — env present and
// bundled assets shipped in the image (openemr shipped an empty corpus once;
// this probe is what catches that class of bug). Always 200 with a body that
// says degraded-or-not, so orchestrators don't kill the container.
export async function GET() {
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  const checks: Record<string, boolean> = {
    // The .env.example placeholder must not read as ready — a cloner who
    // skipped the "put your real key in" step would get a green probe and
    // then failing checks.
    api_key_present: Boolean(key) && !key.includes("your-key"),
    samples_bundled: fs.existsSync(path.join(process.cwd(), "samples")),
  };
  const ready = Object.values(checks).every(Boolean);
  return NextResponse.json({ ready, checks, ts: new Date().toISOString() });
}
