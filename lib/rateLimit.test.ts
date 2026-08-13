import { describe, it, expect, beforeEach } from "vitest";
import { clientIp, rateLimited, resetRateLimit, RATE_LIMITS } from "./rateLimit.ts";

/** Regression cover for the audit finding: the limiter keyed on the FIRST
 *  x-forwarded-for hop, which the caller writes, so rotating it minted a
 *  fresh bucket per request and the ceiling never applied. */

const reqWith = (headers: Record<string, string>) =>
  new Request("https://example.test/api/check", { method: "POST", headers });

describe("clientIp", () => {
  it("takes the proxy-appended hop, not the client-supplied first one", () => {
    // Railway appends the real client IP after whatever the caller sent.
    const req = reqWith({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" });
    expect(clientIp(req)).toBe("203.0.113.9");
  });

  it("handles a single hop", () => {
    expect(clientIp(reqWith({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip, then to a local sentinel", () => {
    expect(clientIp(reqWith({ "x-real-ip": "198.51.100.7" }))).toBe("198.51.100.7");
    expect(clientIp(reqWith({}))).toBe("local");
  });

  it("ignores empty and whitespace-only hops", () => {
    expect(clientIp(reqWith({ "x-forwarded-for": "1.2.3.4, , " }))).toBe("1.2.3.4");
  });
});

describe("rateLimited", () => {
  beforeEach(resetRateLimit);

  it("allows traffic below the per-IP ceiling", () => {
    const req = reqWith({ "x-forwarded-for": "203.0.113.9" });
    for (let i = 0; i < RATE_LIMITS.PER_IP_LIMIT; i++) {
      expect(rateLimited(req)).toBe(false);
    }
  });

  it("rejects past the per-IP ceiling", () => {
    const req = reqWith({ "x-forwarded-for": "203.0.113.9" });
    for (let i = 0; i < RATE_LIMITS.PER_IP_LIMIT; i++) rateLimited(req);
    expect(rateLimited(req)).toBe(true);
  });

  it("cannot be bypassed by rotating the client-supplied hop", () => {
    // The attack: a fresh forged first hop on every request. The proxy hop
    // stays constant, so all of it lands in one bucket.
    const spoof = (n: number) =>
      reqWith({ "x-forwarded-for": `10.0.0.${n % 250}, 203.0.113.9` });
    for (let i = 0; i < RATE_LIMITS.PER_IP_LIMIT; i++) rateLimited(spoof(i));
    expect(rateLimited(spoof(999))).toBe(true);
  });

  it("does not let one abuser spend the whole global budget", () => {
    // The DoS this ordering exists to prevent: while the global counter was
    // incremented before the per-IP decision, requests that were ALREADY being
    // rejected kept the shared window full, so one IP locked everyone out.
    const abuser = reqWith({ "x-forwarded-for": "203.0.113.99" });
    for (let i = 0; i < RATE_LIMITS.GLOBAL_LIMIT * 2; i++) rateLimited(abuser);
    const bystander = reqWith({ "x-forwarded-for": "198.51.100.5" });
    expect(rateLimited(bystander)).toBe(false);
  });

  it("caps any single IP's contribution to the global window", () => {
    // Even sustained abuse may only ever put PER_IP_LIMIT into the shared
    // bucket, so it takes several distinct sources to exhaust it.
    const abuser = reqWith({ "x-forwarded-for": "203.0.113.99" });
    for (let i = 0; i < 5000; i++) rateLimited(abuser);
    let survived = 0;
    for (let i = 0; i < RATE_LIMITS.GLOBAL_LIMIT - RATE_LIMITS.PER_IP_LIMIT; i++) {
      if (!rateLimited(reqWith({ "x-forwarded-for": `198.51.100.${i % 250}` }))) survived++;
    }
    expect(survived).toBeGreaterThan(RATE_LIMITS.GLOBAL_LIMIT - RATE_LIMITS.PER_IP_LIMIT - 1);
  });

  it("still stops a distributed drain via the global ceiling", () => {
    // Every request from a genuinely different proxy hop — per-IP never
    // trips, so only the global ceiling stands between this and the bill.
    let blocked = false;
    for (let i = 0; i < RATE_LIMITS.GLOBAL_LIMIT + 5; i++) {
      if (rateLimited(reqWith({ "x-forwarded-for": `203.0.113.${i % 250}, 198.51.100.${i % 250}` }))) {
        blocked = true;
        break;
      }
    }
    expect(blocked).toBe(true);
  });

  it("keeps separate IPs in separate buckets", () => {
    const a = reqWith({ "x-forwarded-for": "203.0.113.1" });
    const b = reqWith({ "x-forwarded-for": "203.0.113.2" });
    for (let i = 0; i < RATE_LIMITS.PER_IP_LIMIT; i++) rateLimited(a);
    expect(rateLimited(a)).toBe(true);
    expect(rateLimited(b)).toBe(false);
  });

  it("leaves headroom for a full-speed 300-label batch", () => {
    // 300 labels x 2 upstream-bound calls, 8 concurrent — must never 429.
    const req = reqWith({ "x-forwarded-for": "203.0.113.9" });
    let tripped = 0;
    for (let i = 0; i < 240; i++) if (rateLimited(req)) tripped++;
    expect(tripped).toBe(0);
  });
});
