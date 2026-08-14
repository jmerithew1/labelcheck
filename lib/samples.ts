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
 *  Four distinct labels across four distinct condition families (glare, low
 *  light, colour cast, shadow), and each variant was selected because its
 *  measured verdict MATCHES its pristine baseline — the picture gets visibly
 *  worse, the verdict does not move. Change an image here only via that
 *  script, or the card can quietly start demonstrating something else.
 */

export interface DemoSample {
  id: string;
  title: string;
  blurb: string;
  /** The dot on the card, which must be the colour the card's RESULT lands on.
   *  The "warning issue" card carried an amber dot and returned a red failure —
   *  the one card whose whole job is to show a hard fail was advertising itself
   *  as a maybe. A card's dot is a promise about its verdict; keep it in step
   *  with the measured verdict in samples/demo/manifest.json. */
  tone: "green" | "amber" | "red";
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
    // Shot through a glare off the glass. Chosen over the rotated variant
    // because a card promising "everything lines up" has to COME BACK clean,
    // and the deskewed rotation left the stroke-width gate unable to resolve
    // the bold prefix — so the one spotless demo ended on an amber "1 item
    // needs confirmation". This variant measured 4/4 clean/pass live with the
    // widest bold margin on the label; see pick-demo-samples.mjs for the two
    // candidates rejected in between.
    id: "clean",
    title: "Clean match",
    blurb: "Everything lines up",
    tone: "green",
    png: "clean-match--glare2.png",
    application: OLD_TOM,
  },
  {
    // shot in poor light
    id: "mismatch",
    title: "Mismatch",
    blurb: "Alcohol content differs",
    tone: "red",
    png: "harbor-gin--dark3.png",
    application: { ...GIN, alcohol_content: "40% Alc./Vol. (80 Proof)" },
  },
  {
    // colour cast from indoor lighting; the prefix is Title Case, not ALL CAPS
    id: "warning",
    title: "Warning issue",
    blurb: "Warning formatting fails",
    // red, not amber: Title Case in the prefix is an outright failure of
    // 27 CFR 16.22(a)(2), and the result screen says so in red.
    tone: "red",
    png: "title-case-prefix--cast2.png",
    application: OLD_TOM,
  },
  {
    // deep shadow across the label
    id: "complex",
    title: "Multiple issues",
    blurb: "Two fields to review",
    tone: "red",
    png: "batch-vodka--shadow2.png",
    application: {
      ...VODKA,
      class_type: "Grain Vodka",
      alcohol_content: "37.5% Alc./Vol. (75 Proof)",
    },
  },
];

/** The "Need test files?" downloads. Deliberately different conditions again —
 *  a tilt, a blur and a steep angle — so anyone who grabs these to try the tool
 *  themselves is testing it on photographs, not on clean artwork. */
export const DOWNLOAD_SAMPLES = [
  "wine-label--rot1.png",
  "case-diff--blur2.png",
  "word-drop--angle3.png",
];
