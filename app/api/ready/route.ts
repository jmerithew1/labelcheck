import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

// Readiness: asserts the runtime actually has what it needs — env present and
// bundled assets shipped in the image (openemr shipped an empty corpus once;
// this probe is what catches that class of bug). Always 200 with a body that
// says degraded-or-not, so orchestrators don't kill the container.
// One paid upstream call per minute at most, shared across all callers.
const DEEP_TTL_MS = 60_000;
let deepCache: { at: number; usable: boolean; detail?: string } | null = null;

export async function GET(req: Request) {
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  const checks: Record<string, boolean> = {
    // The .env.example placeholder must not read as ready — a cloner who
    // skipped the "put your real key in" step would get a green probe and
    // then failing checks.
    api_key_present: Boolean(key) && !key.includes("your-key"),
    samples_bundled: fs.existsSync(path.join(process.cwd(), "samples")),
  };

  // A key that EXISTS is not a key that WORKS. An exhausted credit balance or
  // a revoked key fails every check while this probe still reports ready —
  // observed in practice, so ?deep=1 spends one token to actually transact.
  // Opt-in: the cheap probe stays free for orchestrator polling.
  // The deep probe costs money on every call, and this endpoint is public and
  // unauthenticated — /api/check is rate-limited, this was not. Cache the
  // result so a loop cannot drain the credit balance (the exact failure that
  // took the deployment down once already), and so orchestrator polling stays
  // effectively free.
  let detail: string | undefined;
  const wantsDeep = new URL(req.url).searchParams.get("deep") === "1";
  if (wantsDeep && deepCache && Date.now() - deepCache.at < DEEP_TTL_MS) {
    checks.api_usable = deepCache.usable;
    detail = deepCache.detail;
  } else if (wantsDeep && checks.api_key_present) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "." }] }),
        signal: AbortSignal.timeout(10_000),
      });
      checks.api_usable = res.ok || res.status === 429; // rate-limited still means funded
      if (!checks.api_usable) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        detail = body?.error?.message ?? `HTTP ${res.status}`;
      }
      deepCache = { at: Date.now(), usable: checks.api_usable, detail };
    } catch (e) {
      checks.api_usable = false;
      detail = e instanceof Error ? e.message : "upstream unreachable";
      deepCache = { at: Date.now(), usable: false, detail };
    }
  }

  const ready = Object.values(checks).every(Boolean);
  return NextResponse.json({ ready, checks, ...(detail ? { detail } : {}), ts: new Date().toISOString() });
}
