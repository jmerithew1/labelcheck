// @vitest-environment node
import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { classifyExtractionError, failureMessage, type ExtractionFailure } from "./extract.ts";

/** The branch ORDER in classifyExtractionError is load-bearing and has been
 *  wrong once before: APIConnectionTimeoutError extends APIError, so a
 *  generic APIError branch checked first swallowed every timeout and the one
 *  message that tells the user the image may be too large was dead code.
 *  These tests hold the ordering and the mapping in place. */

describe("classifyExtractionError", () => {
  it("classifies the SDK timeout as timeout, NOT as the generic APIError it also is (the prior bug)", () => {
    const e = new Anthropic.APIConnectionTimeoutError({ message: "Request timed out." });
    expect(e).toBeInstanceOf(Anthropic.APIError); // the trap that caused the bug
    expect(classifyExtractionError(e)).toEqual({ kind: "timeout" });
  });

  it("classifies a plain timed-out error as timeout", () => {
    expect(classifyExtractionError(new Error("fetch timed out after 30000ms"))).toEqual({ kind: "timeout" });
  });

  it("maps 429 to rate_limited", () => {
    const e = new Anthropic.APIError(429, undefined, "rate limit", undefined);
    expect(classifyExtractionError(e)).toEqual({ kind: "rate_limited" });
  });

  it("maps 401 and 403 to not_configured — a bad key cannot be retried away", () => {
    for (const status of [401, 403]) {
      const e = new Anthropic.APIError(status, undefined, "auth", undefined);
      expect(classifyExtractionError(e)).toEqual({ kind: "not_configured" });
    }
  });

  it("maps other API statuses to api_error with the status in the detail", () => {
    const e = new Anthropic.APIError(500, undefined, "boom", undefined);
    const f = classifyExtractionError(e);
    expect(f.kind).toBe("api_error");
    expect((f as Extract<ExtractionFailure, { kind: "api_error" }>).detail).toContain("500");
  });

  it("recognises the SDK's request-time missing-key Error as not_configured", () => {
    expect(classifyExtractionError(new Error("Could not resolve authentication method. Expected the apiKey to be set."))).toEqual({ kind: "not_configured" });
  });

  it("falls back to api_error for anything else, truncating the detail", () => {
    const f = classifyExtractionError("x".repeat(500));
    expect(f.kind).toBe("api_error");
    expect((f as Extract<ExtractionFailure, { kind: "api_error" }>).detail.length).toBeLessThanOrEqual(200);
  });
});

describe("failureMessage", () => {
  it("not_configured copy never says 'try again' — nothing the user does will help", () => {
    expect(failureMessage({ kind: "not_configured" }).toLowerCase()).not.toContain("try again");
  });

  it("timeout copy is the one that mentions image size", () => {
    expect(failureMessage({ kind: "timeout" }).toLowerCase()).toContain("too large");
  });

  it("every failure kind has non-empty, non-technical copy", () => {
    const kinds: ExtractionFailure[] = [
      { kind: "refusal" }, { kind: "rate_limited" }, { kind: "timeout" },
      { kind: "not_configured" }, { kind: "api_error", detail: "500" },
    ];
    for (const f of kinds) {
      const msg = failureMessage(f);
      expect(msg.length).toBeGreaterThan(20);
      expect(msg).not.toMatch(/API|HTTP|undefined/);
    }
  });
});
