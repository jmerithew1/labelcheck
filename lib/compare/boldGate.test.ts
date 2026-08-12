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

/** Resolution floor. Measured on the round-2 corpus: 10 of 35 truly-regular
 *  samples flip to a confident "bold" if the prefix measures one pixel wider,
 *  and 18 of 91 sit below 2 native pixels of body stroke. Arithmetic on 1-2px
 *  integers reads as precision it does not have. */
describe("bold gate abstains when the image lacks the resolution", () => {
  const strongBold = { swRatio: 1.5, densRatio: 1.4, sizeRatio: 1.0 };

  it("still decides when strokes are thick enough", () => {
    expect(applyBoldGate({ ...strongBold, swBodyNativePx: 3 }, "bold")).toBe("bold");
  });

  it("routes to a human below the floor, even with every other signal agreeing", () => {
    expect(applyBoldGate({ ...strongBold, swBodyNativePx: 1.7 }, "bold")).toBe("human");
  });

  it("will not claim not_bold below the floor either", () => {
    const thin = { swRatio: 0.8, densRatio: 1.0, sizeRatio: 1.0, swBodyNativePx: 1.2 };
    expect(applyBoldGate(thin, "not_bold")).toBe("human");
  });

  it("stays backward compatible when the width is unavailable", () => {
    expect(applyBoldGate(strongBold, "bold")).toBe("bold");
  });
});
