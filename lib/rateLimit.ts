/**
 * Shared abuse guard for the paid endpoints.
 *
 * Every route here is public and spends real API credit per call, so the
 * limiter lives in ONE module rather than being copy-pasted per route: the
 * audit found /api/locate had silently missed it while its two siblings had
 * it, which is exactly the failure a fourth endpoint would repeat.
 *
 * Sizing: a full-speed 300-label batch (8 concurrent, ~2 checks/s) must never
 * trip this. The per-IP ceiling is set well above that, and the global
 * ceiling above the per-IP one, so honest traffic never sees a 429.
 *
 * In-memory is correct for this deploy (single container, nothing stored). On
 * a multi-instance deploy the effective limit multiplies — noted rather than
 * solved, because a shared store is not worth a prototype's complexity.
 */

const WINDOW_MS = 60_000;
const PER_IP_LIMIT = 240;
// A spoofed client IP still has to get past this. Sized so the whole batch
// path (300 labels, 2-3 calls each, spread over minutes) stays clear, while a
// scripted drain loop hits a wall in seconds.
const GLOBAL_LIMIT = 900;

const perIp = new Map<string, number[]>();
let globalHits: number[] = [];

/**
 * The client's IP as the PLATFORM saw it.
 *
 * `x-forwarded-for` is a client-writable header that the proxy APPENDS to, so
 * the first entry is whatever the caller typed — keying on it let anyone mint
 * a fresh bucket per request and bypass the limit entirely. The last entry is
 * the hop the proxy itself recorded, which the caller cannot forge.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.headers.get("x-real-ip")?.trim() || "local";
}

/** True when this request should be rejected with a 429. */
export function rateLimited(req: Request): boolean {
  const now = Date.now();

  globalHits = globalHits.filter((t) => now - t < WINDOW_MS);
  globalHits.push(now);
  const overGlobal = globalHits.length > GLOBAL_LIMIT;

  const ip = clientIp(req);
  const hits = (perIp.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  perIp.set(ip, hits);
  if (perIp.size > 10_000) perIp.clear(); // unbounded-growth guard

  return overGlobal || hits.length > PER_IP_LIMIT;
}

/** The 429 every guarded route returns, so the copy stays identical. */
export const RATE_LIMIT_MESSAGE =
  "Too many requests right now — wait a minute and try again.";

/** Test seam: reset the windows between cases. */
export function resetRateLimit(): void {
  perIp.clear();
  globalHits = [];
}

export const RATE_LIMITS = { WINDOW_MS, PER_IP_LIMIT, GLOBAL_LIMIT } as const;
