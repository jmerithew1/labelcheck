# LabelCheck Requirements Rubric

Every requirement extracted from [brief.md](brief.md), tracked with evidence. Vocabulary: **MET** (with evidence), **PARTIAL**, **MISSING**, **N/A-documented**. A claim only moves to MET with a file, test, measured number, or URL attached — never on "code written."

Verification points: spec approval (done), post-build final gate, pre-submit.

## Hard requirements (miss one = auto-fail)

### Deliverables
- **D1 — MET** Source repo, buildable from clean clone — this repo; `npm install && npm run build` green
- **D2 — MET** README with working setup/run — [README.md](../README.md)
- **D3 — MET** Approach/assumptions doc with trade-offs — [approach.md](approach.md)
- **D4 — MET** Deployed URL — https://labelcheck-production-8f22.up.railway.app (readiness probe `/api/ready`)

### Core function
- **C1 — MET** Accepts label image + application data — single-check form ([components/CheckForm.tsx](../components/CheckForm.tsx)) and batch CSV+images ([components/BatchRunner.tsx](../components/BatchRunner.tsx)) → [app/api/check/route.ts](../app/api/check/route.ts)
- **C2 — MET** Brand name verified — [lib/compare/fields.ts](../lib/compare/fields.ts); tests in [compare.test.ts](../lib/compare/compare.test.ts)
- **C3 — MET** Class/type verified — same module + tests
- **C4 — MET** Alcohol content format-tolerant: `45% Alc./Vol. (90 Proof)` vs `45%` = MATCH — [lib/compare/abv.ts](../lib/compare/abv.ts); test "matches the rubric's exact example"; verified live in browser (case-diff sample)
- **C5 — MET** Net contents: 750 mL = 750ml = 75 cl = 750 milliliters — [lib/compare/netContents.ts](../lib/compare/netContents.ts) + tests; verified live (75 cl sample)
- **C6 — MET** Warning presence, tri-state — [lib/vision/contract.ts](../lib/vision/contract.ts) + [lib/compare/warning.ts](../lib/compare/warning.ts)
- **C7 — MET** Warning EXACT word-for-word vs canonical 27 CFR 16.21 — [lib/compare/warning.ts](../lib/compare/warning.ts) (canonical text SME-verified vs GPO/LII); adversarial tests (word-swap, word-drop, punctuation); live: word-swap label fails with deviation named
- **C8 — MET** `GOVERNMENT WARNING` ALL-CAPS check; title case = hard fail — same module + test; live: title-case sample fails with §16.22(a)(2) citation
- **C9 — MET (as designed: advisory + documented limitation)** Bold prefix — Sonnet parallel judgment, measured 16/17 ([spike-results.md](spike-results.md)); surfaced as advisory with the number; limitation in [approach.md](approach.md)
- **C10 — MET** Fuzzy fields, case/punct = MATCH surfaced: `STONE'S THROW` = `Stone's Throw` — [lib/compare/fields.ts](../lib/compare/fields.ts) + test; live: case-diff sample & batch case-diff rows land clean-with-note
- **C11 — MET** Diffs/confidence visible; agent decides — char-level diffs ([components/CharDiff.tsx](../components/CharDiff.tsx)), similarity %, verdict language; only the warning uses FAIL language
- **C12 — MET** Bottler name/address optional field — form + engine, skipped-when-blank shown
- **C13 — MET** Country of origin optional field — same

### Performance
- **P1 — MET** ~5s per label MEASURED on deployed URL: **p50 4.0s, worst 4.4s, n=7** — [measured-performance.json](measured-performance.json)
- **P2 — MET** Batch 200–300 first-class — batch page, CSV+images, loud pairing, sample batch button
- **P3 — MET** 250-label batch **121s wall-clock, 250/250 ok, 0 rate-limited** on deployed app — [measured-performance.json](measured-performance.json)

### UX
- **U1 — MET** Non-technical 50+ usable — 3-click demo verified in browser: sample → rendered verdict (single) and sample batch → triage, zero downloads/instructions; UX cold-read at final gate
- **U2 — MET** Loud human-readable errors — type/size guards, refusal/timeout/429 copy ([lib/vision/extract.ts](../lib/vision/extract.ts) `failureMessage`), not-a-label card, CSV-format and pairing errors
- **U3 — MET** Triage 250 without drowning — summary strip, exceptions sorted top, clean collapsed, row detail, **Download results (CSV)**, refresh guard; verified in browser on sample batch

### Constraints
- **S1 — MET** Standalone, zero COLA integration — no integration code; stated in approach doc
- **S2 — MET** Nothing sensitive stored — no DB/auth/retention; key server-side; `.env.local` gitignored

## Soft requirements (writeup lines mandatory)
- **N1 — N/A-documented** Photo tolerance deferred — plan + degradation behavior in [approach.md](approach.md) §limitations
- **N2 — MET** Blocked-network path — approach doc §deployment (Bedrock GovCloud / Azure gateway / on-prem VLM)
- **N3 — MET** Test labels — 18 ground-truthed labels incl. adversarial + injection ([samples/](../samples)), AI-encouraged generation honored via HTML-render pipeline

## Graded criteria (final-gate walk)
- **E1** Correctness/completeness — all C-rows above
- **E2** Code quality — pure tested engine (31 tests), thin UI, flat contracts
- **E3** Appropriate tech choices — decisions log with rejected alternatives ([decisions.md](decisions.md))
- **E4** UX & error handling — U-rows
- **E5** Attention to requirements — this file
- **E6** Creative problem-solving — perception/verdict split, hybrid two-model parallel extraction, adversarial spike method
- **E7** Working core over ambition — degradation ladder honored (XLSX cut, everything else shipped)
- **E8** Gaps filled independently — CSV convention, optional fields, injection defense (documented in approach.md)
