/** Bundled demo pairs: label image + the application data it's checked against.
 *  These make every core behavior demonstrable in 3 clicks with zero
 *  evaluator-supplied data (U1). Images served via /api/samples/[name]. */

export interface DemoSample {
  id: string;
  title: string;
  blurb: string;
  /** one-line payoff shown on the example button */
  hook: string;
  /** file under samples/labels */
  png: string;
  application: {
    brand_name: string;
    class_type: string;
    alcohol_content: string;
    net_contents: string;
  };
}

export const DEMO_SAMPLES: DemoSample[] = [
  {
    id: "clean",
    title: "Clean match",
    blurb: "Label and application agree on everything.",
    hook: "see a full check in ~4 seconds",
    png: "clean-match.png",
    application: {
      brand_name: "OLD TOM DISTILLERY",
      class_type: "Kentucky Straight Bourbon Whiskey",
      alcohol_content: "45% Alc./Vol. (90 Proof)",
      net_contents: "750 mL",
    },
  },
  {
    id: "case-diff",
    title: "Formatting difference",
    blurb: "Same brand, different capitalization — a match, surfaced not failed.",
    hook: "see it NOT flag a case difference",
    png: "case-diff.png",
    application: {
      brand_name: "OLD TOM DISTILLERY",
      class_type: "Kentucky Straight Bourbon Whiskey",
      alcohol_content: "45%",
      net_contents: "75 cl",
    },
  },
  {
    id: "warning-fail",
    title: "Warning issue",
    blurb: 'Warning prefix printed "Government Warning:" — title case fails the exact check.',
    hook: "see it catch a formatting violation",
    png: "title-case-prefix.png",
    application: {
      brand_name: "OLD TOM DISTILLERY",
      class_type: "Kentucky Straight Bourbon Whiskey",
      alcohol_content: "45% Alc./Vol. (90 Proof)",
      net_contents: "750 mL",
    },
  },
];
