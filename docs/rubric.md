# LabelCheck Requirements Rubric

Every requirement extracted from [brief.md](brief.md), tracked with evidence. Vocabulary: **MET** (with evidence), **PARTIAL**, **MISSING**, **N/A-documented**. A claim only moves to MET with a file, test, measured number, or URL attached — never on "code written."

Verification points: spec approval (done), post-build final gate (done), pre-submit audit loop (done 2026-08-11): round 1 — 5 independent auditor lanes (clean-clone build, core claims, live app, brief-coverage adversary, docs-drift), 0 blockers / 9 minors, all fixed; round 2 — 4 lanes re-verifying live production behavior + docs, 0 blockers / 3 doc-accuracy minors, all fixed; round 3 — scoped re-check of the round-2 fixes found 3 residual doc findings (stale claims duplicated in the generator and decisions log; an unbacked latency number), fixed; round 4 — final re-check of the round-3 fixes, clean (loop exit).

## Hard requirements (miss one = auto-fail)

### Deliverables
- **D1 — MET** Source repo, buildable from clean clone — this repo; `npm install && npm run build` green
- **D2 — MET** README with working setup/run — [README.md](../README.md)
- **D3 — MET** Approach doc covering all three required parts — approach ([approach.md](approach.md)), **tools used** (§tools-used: runtime stack, models, test/measurement harnesses, label generation, AI-assisted dev process), assumptions (§assumptions) — plus trade-offs
- **D4 — MET** Deployed URL — https://labelcheck-production-8f22.up.railway.app (readiness probe `/api/ready`)

### Core function
- **C1 — MET** Accepts label image + application data — single-check form ([components/SingleCheck.tsx](../components/SingleCheck.tsx)) and batch CSV+images ([components/BatchReview.tsx](../components/BatchReview.tsx)) → [app/api/check/route.ts](../app/api/check/route.ts)
- **C2 — MET** Brand name verified — [lib/compare/fields.ts](../lib/compare/fields.ts); tests in [compare.test.ts](../lib/compare/compare.test.ts)
- **C3 — MET** Class/type verified — same module + tests
- **C4 — MET** Alcohol content format-tolerant: `45% Alc./Vol. (90 Proof)` vs `45%` = MATCH — [lib/compare/abv.ts](../lib/compare/abv.ts); test "matches the rubric's exact example"; verified live in browser (batch case-diff rows; case-diff label downloadable on the single-check page)
- **C5 — MET** Net contents: 750 mL = 750ml = 75 cl = 750 milliliters — [lib/compare/netContents.ts](../lib/compare/netContents.ts) + tests; verified live (75 cl sample)
- **C6 — MET** Warning presence, tri-state — [lib/vision/contract.ts](../lib/vision/contract.ts) + [lib/compare/warning.ts](../lib/compare/warning.ts)
- **C7 — MET** Warning EXACT word-for-word vs canonical 27 CFR 16.21 — [lib/compare/warning.ts](../lib/compare/warning.ts) (canonical text SME-verified vs GPO/LII); adversarial tests (word-swap, word-drop, punctuation); live: word-swap label fails with deviation named
- **C8 — MET** `GOVERNMENT WARNING` ALL-CAPS check; title case = hard fail — same module + test; live: title-case sample fails with §16.22(a)(2) citation
- **C9 — MET (as designed: advisory + documented limitation)** Bold prefix — Sonnet parallel judgment, measured 16/17 ([spike-results.md](spike-results.md)); surfaced as advisory with the number; limitation in [approach.md](approach.md)
- **C10 — MET** Fuzzy fields, case/punct = MATCH surfaced: `STONE'S THROW` = `Stone's Throw` — [lib/compare/fields.ts](../lib/compare/fields.ts) + test; live: batch case-diff rows land clean-with-note (case-diff label also downloadable for single check)
- **C11 — MET** Diffs/confidence visible; agent decides — char-level diffs ([components/CharDiff.tsx](../components/CharDiff.tsx)), similarity %, verdict language; only the warning uses FAIL language
- **C12 — MET** Bottler name/address optional field — form + engine, skipped-when-blank shown
- **C13 — MET** Country of origin optional field — same
- **C14 — MET** Jenny's evasion tactics all countered — *different wording*: exact canonical comparison + character diff (C7); *smaller font*: extractor reports warning size relative to the label, surfaces an advisory even when text is exact ([lib/vision/contract.ts](../lib/vision/contract.ts) `warning_text_size`; physical mm/characters-per-inch documented as not machine-checkable from an image, [approach.md](approach.md) §limitations); *buried in tiny text*: full-label transcription + tri-state presence — a warning anywhere on the label is found or its absence/illegibility flagged

### Performance
- **P1 — MET** ~5s per label MEASURED on deployed URL (incl. evidence-band call): **p50 4.3s, worst 4.5s, n=6** — [measured-performance.json](measured-performance.json). Warning-*failing* labels take ~8s (measured 8.1–8.3s live, raw timings in the same evidence file) because they pay the deliberate second-reading confirmation pass — the false-rejection-aversion trade-off (U4); clean/typical labels stay under 5s
- **P2 — MET** Batch 200–300 first-class — batch review page: CSV+files dropzone, loud pairing, filters/search/pagination, detail panel, sample batch
- **P3 — MET** 250-label batch **135s wall-clock, 250/250 ok, 0 rate-limited, 0 errors** on deployed app — [measured-performance.json](measured-performance.json)

### UX
- **U1 — MET** Non-technical 50+ usable — 3-click demo verified in browser: sample → rendered verdict (single) and sample batch → triage, zero downloads/instructions; UX cold-read at final gate
- **U2 — MET** Loud human-readable errors — type/size guards, refusal/timeout/429 copy ([lib/vision/extract.ts](../lib/vision/extract.ts) `failureMessage`), not-a-label card, CSV-format and pairing errors
- **U3 — MET** Triage 250 without drowning — count-carrying filter chips (All / Matched / Need review / Not required), one-click **Need review** filter + search, master-detail table (row click opens the evidence panel with an Audit trail tab, Review next steps through), **Download report** (CSV), refresh guard; verified in browser on sample batch
- **U4 — MET** Dave's "don't make my life harder" = false-rejection aversion, designed in — tri-state `unreadable` ≠ `missing` (glare → "check manually", never a fail); second-reading confirmation on warning failures (measured zero false rejections on the degraded set); verdict vocabulary surfaces, never auto-rejects; case/punct differences read "Match — formatting differs" ([approach.md](approach.md) §perception/verdict, [degraded-fidelity.json](degraded-fidelity.json))

### Constraints
- **S1 — MET** Standalone, zero COLA integration — no integration code; stated in approach doc
- **S2 — MET** Nothing sensitive stored — no DB/auth/retention; key server-side; `.env.local` gitignored

## Soft requirements (writeup lines mandatory)
- **N1 — PARTIAL (measured, not field-tested)** Photo tolerance — validated on simulated degradations (blur/tilt/glare × 5 labels): **15/15 verdicts correct or safely degraded, zero false rejections**, 3/3 degraded false warning-failures rescued by the second-reading pass ([degraded-fidelity.json](degraded-fidelity.json)); real photographed bottles untested — [approach.md](approach.md) §limitations item 4
- **N2 — MET** Blocked-network path — approach doc §deployment (Bedrock GovCloud / Azure gateway / on-prem VLM)
- **N3 — MET** Test labels — 18 ground-truthed labels incl. adversarial + injection ([samples/](../samples)), AI-encouraged generation honored via HTML-render pipeline
- **N4 — MET (documented assumption)** "Requirements vary by beverage type (beer/wine/distilled spirits)" — one commodity-neutral ruleset shipped and justified (label-vs-application matching is the same question for every commodity; per-commodity mandatory-field lists are a documented production enhancement) — [approach.md](approach.md) §assumptions; sample set covers spirits/wine/beer archetypes

## Graded criteria (final-gate walk)
- **E1** Correctness/completeness — all C-rows above
- **E2** Code quality — pure tested engine (77 tests incl. review-regression suite), thin UI, flat contracts
- **E3** Appropriate tech choices — decisions log with rejected alternatives ([decisions.md](decisions.md))
- **E4** UX & error handling — U-rows
- **E5** Attention to requirements — this file
- **E6** Creative problem-solving — perception/verdict split, hybrid two-model parallel extraction, adversarial spike method
- **E7** Working core over ambition — degradation ladder honored (XLSX cut, everything else shipped)
- **E8** Gaps filled independently — CSV convention, optional fields, injection defense (documented in approach.md)
