# Take-Home Project: AI-Powered Alcohol Label Verification App

> Extracted from `take-home-brief.docx` (same folder). This is the working reference; the docx is the source of record.

## The task

Build a standalone prototype that helps TTB compliance agents verify alcohol beverage label images against application data — does what's on the label match what's on the form? Free choice of languages/frameworks. Deliverables: source repo (README, setup/run instructions, approach/assumptions doc) **and a deployed application URL**.

## Stakeholder requirements (from interview notes)

**Sarah Chen, Deputy Director of Label Compliance:**
- TTB reviews ~150,000 label applications/year with 47 agents; ~5–10 min per simple application.
- Core work is matching: brand name, ABV, government warning presence vs. the application form. Agents "drowning in routine stuff."
- **Hard latency requirement: results in ~5 seconds.** A prior vendor pilot took 30–40s per label and agents abandoned it.
- **UI must be dead simple** — "something my mother could figure out" (she's 73). Half the team is over 50. Clean, obvious, no hunting for buttons.
- **Batch uploads matter**: peak-season importers dump 200–300 applications at once; currently processed one at a time.

**Marcus Williams, IT Systems Administrator:**
- Prototype is standalone — **no COLA integration** (that's years away; separate authorization).
- Azure shop, FedRAMP-conscious, but "for a prototype, just don't do anything crazy" — nothing sensitive stored.
- Their network **blocks outbound traffic to many domains** — cloud ML endpoints broke the last vendor pilot. Worth acknowledging in the writeup even if the prototype uses cloud APIs.

**Dave Morrison, Senior Compliance Agent (28 yrs):**
- Matching needs **judgment, not exact string equality**: `STONE'S THROW` on the label vs `Stone's Throw` in the application is obviously the same thing. Fuzzy/normalized matching with the mismatch surfaced, not auto-rejected.
- Skeptical of modernization projects; the tool must not make his life harder.

**Jenny Park, Junior Compliance Agent:**
- **Government warning check is strict and exact**: word-for-word text, `GOVERNMENT WARNING:` must be ALL CAPS and bold. Title case = rejection. Applicants try smaller fonts, altered wording, buried text.
- Stretch goal: tolerate imperfect photos (weird angles, bad lighting, glare) — today agents just reject and re-request.

## TTB label elements (reference)

Brand name · class/type designation · alcohol content · net contents · name/address of bottler/producer · country of origin (imports) · Government Health Warning Statement (mandatory on all). Requirements vary by beverage type (beer / wine / distilled spirits). See ttb.gov.

**Sample distilled spirits label fields:**
- Brand Name: "OLD TOM DISTILLERY"
- Class/Type: "Kentucky Straight Bourbon Whiskey"
- Alcohol Content: "45% Alc./Vol. (90 Proof)"
- Net Contents: "750 mL"
- Government Warning: [standard text]

They encourage generating additional test labels with AI image tools.

## Evaluation criteria

- Correctness and completeness of core requirements
- Code quality and organization
- Appropriate technical choices for the scope
- User experience and error handling
- Attention to requirements
- Creative problem-solving

Stated preference: **a working core application with clean code over ambitious but incomplete features.** Document trade-offs and limitations. They also value how you fill in gaps independently.
