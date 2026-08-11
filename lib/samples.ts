/** v2 sample cards (design §Single check — TRY A SAMPLE, 2×2 grid): four
 *  archetypes, each a REAL check against a bundled label — the "mismatch"
 *  and "multiple issues" cards plant wrong application values so the live
 *  engine produces genuine mismatch verdicts. Images served via
 *  /api/samples/[name]. */

export interface DemoSample {
  id: string;
  title: string;
  blurb: string;
  /** file under samples/labels */
  png: string;
  application: {
    brand_name: string;
    class_type: string;
    alcohol_content: string;
    net_contents: string;
  };
}

const OLD_TOM = {
  brand_name: "OLD TOM DISTILLERY",
  class_type: "Kentucky Straight Bourbon Whiskey",
  alcohol_content: "45% Alc./Vol. (90 Proof)",
  net_contents: "750 mL",
};

export const DEMO_SAMPLES: DemoSample[] = [
  {
    id: "clean",
    title: "Clean match",
    blurb: "Everything lines up",
    png: "clean-match.png",
    application: OLD_TOM,
  },
  {
    id: "mismatch",
    title: "Mismatch",
    blurb: "Alcohol content differs",
    png: "clean-match.png",
    application: { ...OLD_TOM, alcohol_content: "40% Alc./Vol. (80 Proof)" },
  },
  {
    id: "warning",
    title: "Warning issue",
    blurb: "Warning formatting fails",
    png: "title-case-prefix.png",
    application: OLD_TOM,
  },
  {
    id: "complex",
    title: "Multiple issues",
    blurb: "Two fields to review",
    png: "clean-match.png",
    application: {
      ...OLD_TOM,
      class_type: "Small Batch Bourbon Whiskey",
      alcohol_content: "40% Alc./Vol. (80 Proof)",
    },
  },
];
