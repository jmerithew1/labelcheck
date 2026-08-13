/** v2 sample cards (design §Single check — TRY A SAMPLE, 2×2 grid): four
 *  archetypes, each a REAL check against a bundled label — the "mismatch"
 *  and "multiple issues" cards plant wrong application values so the live
 *  engine produces genuine mismatch verdicts. Images served via
 *  /api/samples/[name].
 *
 *  Every image here is a DEGRADED photo-condition variant, not a pristine
 *  render, chosen by samples/tools/pick-demo-samples.mjs against measured
 *  verdicts (docs/robustness-matrix.json, overlaid with post-enhancement
 *  results). Two reasons:
 *
 *  1. The old set served the SAME clean PNG for three of the four cards — the
 *     archetypes came entirely from mutating application data. Four near
 *     identical spotless images implied the tool had only ever been tried on
 *     perfect inputs.
 *  2. It is the honest demo. Real submissions are photographs, and the
 *     strongest measured result we have is 544 degraded images across the
 *     brief's three photo conditions with zero false rejections.
 *
 *  Four distinct labels across four distinct condition families (rotation,
 *  low light, glare, low resolution), and each variant was selected because
 *  its measured verdict MATCHES its pristine baseline — the picture gets
 *  visibly worse, the verdict does not move. Change an image here only via
 *  that script, or the card can quietly start demonstrating something else.
 */

export interface DemoSample {
  id: string;
  title: string;
  blurb: string;
  /** file under samples/demo (falls back to samples/labels) */
  png: string;
  application: {
    brand_name: string;
    class_type: string;
    alcohol_content: string;
    net_contents: string;
  };
}

/** Printed values, taken from each label's ground-truth sidecar in
 *  samples/labels/<name>.json. A card that plants a mismatch must start from
 *  its OWN label's true values — copying another label's would change what the
 *  card demonstrates without anything failing loudly. */
const GIN = {
  brand_name: "HARBOR LIGHT GIN",
  class_type: "Distilled Gin",
  alcohol_content: "47% Alc./Vol. (94 Proof)",
  net_contents: "750 mL",
};
const OLD_TOM = {
  brand_name: "OLD TOM DISTILLERY",
  class_type: "Kentucky Straight Bourbon Whiskey",
  alcohol_content: "45% Alc./Vol. (90 Proof)",
  net_contents: "750 mL",
};
const VODKA = {
  brand_name: "SILVER BIRCH VODKA",
  class_type: "Vodka",
  alcohol_content: "40% Alc./Vol. (80 Proof)",
  net_contents: "1 L",
};

export const DEMO_SAMPLES: DemoSample[] = [
  {
    // rotated on the glass — the deskew pass straightens it before the read
    id: "clean",
    title: "Clean match",
    blurb: "Everything lines up",
    png: "clean-match--rot3.png",
    application: OLD_TOM,
  },
  {
    // shot in poor light
    id: "mismatch",
    title: "Mismatch",
    blurb: "Alcohol content differs",
    png: "harbor-gin--dark3.png",
    application: { ...GIN, alcohol_content: "40% Alc./Vol. (80 Proof)" },
  },
  {
    // colour cast from indoor lighting; the prefix is Title Case, not ALL CAPS
    id: "warning",
    title: "Warning issue",
    blurb: "Warning formatting fails",
    png: "title-case-prefix--cast2.png",
    application: OLD_TOM,
  },
  {
    // deep shadow across the label
    id: "complex",
    title: "Multiple issues",
    blurb: "Two fields to review",
    png: "batch-vodka--shadow2.png",
    application: {
      ...VODKA,
      class_type: "Grain Vodka",
      alcohol_content: "37.5% Alc./Vol. (75 Proof)",
    },
  },
];

/** The "Need test files?" downloads. Deliberately different conditions again —
 *  shadow, blur and a steep angle — so anyone who grabs these to try the tool
 *  themselves is testing it on photographs, not on clean artwork. */
export const DOWNLOAD_SAMPLES = [
  "wine-label--glare2.png",
  "case-diff--blur2.png",
  "word-drop--angle3.png",
];
