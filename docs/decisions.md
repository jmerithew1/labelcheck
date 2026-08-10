# Decisions — append-only, newest at top. Every entry names the rejected alternative.

## 2026-08-10 — final-gate fix pass (from 7-agent verification: tests, code review, requirements+attack, UX cold-read, docs clean-clone, 2 blind judges)

Shipped: bold fail-open closed with an always-on hedge note (red team: non-bold prefix read as "bold" — the measured 16/17 miss — sailed through green); two-reading warning confirmation (Sonnet re-reads any text-based warning failure; disagreement downgrades to check-manually — rescued 3/3 false-fails on the degraded set, zero false rejections end-to-end); warning relative-size advisory; thousands-comma volume parse (1,000 ml false-matched 1 mL) + 0.5% relative tolerance (750 mL ≡ 25.4 fl oz); per-IP rate limit 240/min; CSV formula-injection guard; empty-file 400; batch error-row requeue + choosers disabled mid-run + sample batch auto-runs; honest row summaries (formatting diffs never read "Everything matches"); skipped-field AI guesses hidden; diff legend + non-color marking; a11y names; pluralization; allcaps-body ground truth aligned to SME policy; +45 tests (76 total). **Rejected alternatives**: deterministic pixel-level bold check (typography analysis blows prototype scope — hedge + measured number instead); server-side batch persistence (prototype "nothing stored" stance kept; refresh guard + CSV export are the mitigations).

## 2026-08-10 — final-gate 4a notes

(1) XLSX manifests cut per pre-approved degradation ladder step 1 — CSV + downloadable sample defines the format; **rejected**: adding the xlsx dependency for a format the sample CSV obviates. (2) Phase-boundary verifier passes for Phases 1–2 consolidated into the final-gate fan-out (phases completed same-day; verifiers see the same code either way); perf-verifier role folded into the requirements verifier since the measured artifact was minutes old — **rejected**: duplicate re-measurement runs for ceremony. (3) Unplanned file `.claude/launch.json` (browser-preview dev tooling) — kept, dev-only. (4) Test labels are HTML/CSS-rendered with programmatic ground truth rather than AI-image-generated (brief "encourages" AI tools) — **rejected**: AI-generated labels as the primary set, because they carry no exact ground truth for the character-level fidelity spike; a few AI-styled variants exist in the set.

## 2026-08-10 — batch orchestration is client-side, not server SSE

Deviation from plan (checked against tracker BEFORE building): the browser parses the CSV, pairs images, and runs a semaphore of 8 concurrent requests to the existing /api/check route, streaming rows into the table as they land. Tracker walk: P2 intact; P3 intact (8 × ~4s → ~2.5 min for 300; 16 concurrent upstream model calls < burst-tested 25); U3 intact; S2 intact (API key stays server-side). **Rejected alternative**: server-side batch endpoint + SSE — more moving parts (job state, streaming protocol, upload-all-first latency) for zero requirement gain on a stateless prototype; progress-streaming falls out of the client loop for free.

## 2026-08-10 — 0b gate: hybrid extraction (Haiku full + Sonnet bold-only, parallel)

Spike (docs/spike-results.md): transcription fidelity 12/12 verbatim on BOTH models incl. all adversarial mutations — the memorized-warning-reconstruction risk did not materialize; no crop-fallback. Injection label transcribed, not obeyed. Sonnet full extraction p50 6.2s FAILS the ~5s bar; Haiku p50 3.8s passes. Bold: Sonnet-full 17/17 but too slow; chosen hybrid = Haiku full extraction ∥ Sonnet dedicated stroke-weight call (16/17, p50 2.4s) → wall-clock ~3.8s, bold 16/17 surfaced as advisory with the measured number (C9 limitation). Burst 25/25 concurrent, 0 rate-limited → semaphore 20. **Rejected alternatives**: Sonnet-only (breaks the latency requirement that killed the prior vendor); Haiku-only (15/17 bold when 16/17 costs zero wall-clock); OCR hybrid / crop-fallback (unneeded at 12/12 fidelity).

## 2026-08-10 — v2.1 — plan review (Gate 2)

Cut standalone red team (injection neutralized by architecture, validated in spike; malformed-input QA folded into U2), spike expanded (burst, bold accuracy, injection), degradation ladder added, tracker contradiction resolved in favor of shipping the tracker. **Rejected alternative**: keeping 4c as a separate agent role — rejected because it validated a designed-in property and inflated Phase 4.

## 2026-08-10 — owner approvals at Gate 2

Commit cadence: local commits at phase boundaries (push only at ship gate). Repo moved OneDrive → `C:\dev\labelcheck` (shipshape's node_modules sync trap). **Rejected alternative**: single commit at ship — rejected for rollback safety and evaluator-readable history.
