# LabelCheck Requirements Rubric

Every requirement extracted from [brief.md](brief.md). Any ❌ in "Hard requirements" at ship time is an auto-fail.
Checked at three points: spec approval (Gate 1), post-build final gate, and pre-submit.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` verified done (with evidence noted).

## Hard requirements (miss one = auto-fail)

### Deliverables
- [ ] **D1** Source repo delivered (accessible, buildable)
- [ ] **D2** README with setup/run instructions that actually work from a clean clone
- [ ] **D3** Approach/assumptions doc — includes trade-offs and limitations explicitly
- [ ] **D4** Deployed application URL — live, working, evaluator can use it without setup

### Core function
- [ ] **C1** Accepts a label image + application form data as input
- [ ] **C2** Verifies brand name (label vs application)
- [ ] **C3** Verifies class/type designation
- [ ] **C4** Verifies alcohol content (format-tolerant: "45% Alc./Vol. (90 Proof)" vs "45%" should match)
- [ ] **C5** Verifies net contents
- [ ] **C6** Verifies government warning presence
- [ ] **C7** Government warning EXACT check: word-for-word standard 27 CFR 16.21 text
- [ ] **C8** Government warning: "GOVERNMENT WARNING:" must be ALL CAPS — title case = fail
- [ ] **C9** Government warning: "GOVERNMENT WARNING:" must be bold — detection or documented limitation with honest surfacing
- [ ] **C10** All non-warning fields: fuzzy/judgment matching — case & punctuation diffs are MATCHES (`STONE'S THROW` = `Stone's Throw`), surfaced not auto-failed
- [ ] **C11** Mismatches/differences are visibly surfaced (confidence, diff, or highlight) — agent makes the final call, not the tool

### Performance
- [ ] **P1** ~5 seconds per label end-to-end (measured, not assumed)
- [ ] **P2** Batch upload of 200–300 applications works as a first-class flow
- [ ] **P3** Batch completes in reasonable wall-clock (parallelism — 300 × 5s serial = 25 min is not acceptable UX)

### UX
- [ ] **U1** Non-technical users over 50 can use it — no hunting for buttons, obvious flow
- [ ] **U2** Clear error handling (bad image, wrong file type, API failure — loud, human-readable)
- [ ] **U3** Batch results triage view — agent can process 250 results without reading each one (sort/filter by pass/fail/needs-review)

### Constraints
- [ ] **S1** Standalone — no COLA integration, no integration code
- [ ] **S2** Nothing sensitive stored (no persistent PII/application data beyond session needs)

## Explicitly-mentioned soft requirements (called out in writeup even if skipped)
- [ ] **N1** Imperfect photo tolerance (angle, glare, lighting) — build or document as limitation
- [ ] **N2** Writeup acknowledges client network blocks outbound domains → on-prem/gov-cloud path for cloud-API prototype
- [ ] **N3** Test labels generated (they encourage AI-generated test labels) — evaluator needs something to test WITH

## Evaluation criteria (graded, not pass/fail — optimize, don't just satisfy)
- [ ] **E1** Correctness & completeness of core requirements
- [ ] **E2** Code quality and organization
- [ ] **E3** Appropriate technical choices for the scope (no over-engineering)
- [ ] **E4** User experience and error handling
- [ ] **E5** Attention to requirements (this rubric is the proof)
- [ ] **E6** Creative problem-solving
- [ ] **E7** Working core > ambitious incomplete — cut features before shipping broken ones
- [ ] **E8** Gaps filled independently with documented assumptions
