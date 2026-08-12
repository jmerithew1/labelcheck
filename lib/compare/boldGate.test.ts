import { describe, expect, it } from "vitest";
import { applyBoldGate, BOLD_GATE } from "./boldGate.ts";

/** The confidence gate that resolves or routes the bold glance — thresholds
 *  are the round-2 validated set (0 confident mistakes incl. on never-seen
 *  fonts); these tests freeze its decision behavior. */
describe("applyBoldGate", () => {
  it("confidently bold only when measurement AND the AI agree strongly", () => {
    expect(applyBoldGate({ swRatio: 1.3, densRatio: 1.6, sizeRatio: 1.0 }, "bold")).toBe("bold");
    // same pixels, AI disagrees → human, never confident
    expect(applyBoldGate({ swRatio: 1.3, densRatio: 1.6, sizeRatio: 1.0 }, "not_bold")).toBe("human");
    expect(applyBoldGate({ swRatio: 1.3, densRatio: 1.6, sizeRatio: 1.0 }, "unclear")).toBe("human");
    // strokes strong but density weak → human
    expect(applyBoldGate({ swRatio: 1.3, densRatio: 0.9, sizeRatio: 1.0 }, "bold")).toBe("human");
  });

  it("confidently not-bold on strong pixel evidence alone (AI is bold-biased)", () => {
    expect(applyBoldGate({ swRatio: 0.8, densRatio: 1.1, sizeRatio: 1.0 }, "bold")).toBe("not_bold");
    // stroke ratio in the ambiguous band → human
    expect(applyBoldGate({ swRatio: 1.0, densRatio: 1.1, sizeRatio: 1.0 }, "bold")).toBe("human");
  });

  it("routes to human on missing or insane measurements", () => {
    expect(applyBoldGate(null, "bold")).toBe("human");
    expect(applyBoldGate({ swRatio: NaN, densRatio: 1.2, sizeRatio: 1.0 }, "bold")).toBe("human");
    // size sanity gate: a prefix 11x the body height is a garbage crop
    expect(applyBoldGate({ swRatio: 1.4, densRatio: 1.5, sizeRatio: 11.3 }, "bold")).toBe("human");
    expect(applyBoldGate({ swRatio: 1.4, densRatio: 1.5, sizeRatio: 0.4 }, "bold")).toBe("human");
  });

  it("boundary values sit exactly on the frozen thresholds", () => {
    expect(applyBoldGate({ swRatio: BOLD_GATE.swHi, densRatio: BOLD_GATE.dHi, sizeRatio: 1.0 }, "bold")).toBe("bold");
    expect(applyBoldGate({ swRatio: BOLD_GATE.swLo, densRatio: BOLD_GATE.dLo, sizeRatio: 1.0 }, "bold")).toBe("not_bold");
    expect(applyBoldGate({ swRatio: (BOLD_GATE.swLo + BOLD_GATE.swHi) / 2, densRatio: 1.2, sizeRatio: 1.0 }, "bold")).toBe("human");
  });
});
