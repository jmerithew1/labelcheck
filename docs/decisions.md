# Decisions — append-only, newest at top. Every entry names the rejected alternative.

## 2026-08-10 — 0b gate: hybrid extraction (Haiku full + Sonnet bold-only, parallel)

Spike (docs/spike-results.md): transcription fidelity 12/12 verbatim on BOTH models incl. all adversarial mutations — the memorized-warning-reconstruction risk did not materialize; no crop-fallback. Injection label transcribed, not obeyed. Sonnet full extraction p50 6.2s FAILS the ~5s bar; Haiku p50 3.8s passes. Bold: Sonnet-full 17/17 but too slow; chosen hybrid = Haiku full extraction ∥ Sonnet dedicated stroke-weight call (16/17, p50 2.4s) → wall-clock ~3.8s, bold 16/17 surfaced as advisory with the measured number (C9 limitation). Burst 25/25 concurrent, 0 rate-limited → semaphore 20. **Rejected alternatives**: Sonnet-only (breaks the latency requirement that killed the prior vendor); Haiku-only (15/17 bold when 16/17 costs zero wall-clock); OCR hybrid / crop-fallback (unneeded at 12/12 fidelity).

## 2026-08-10 — v2.1 — plan review (Gate 2)

Cut standalone red team (injection neutralized by architecture, validated in spike; malformed-input QA folded into U2), spike expanded (burst, bold accuracy, injection), degradation ladder added, tracker contradiction resolved in favor of shipping the tracker. **Rejected alternative**: keeping 4c as a separate agent role — rejected because it validated a designed-in property and inflated Phase 4.

## 2026-08-10 — owner approvals at Gate 2

Commit cadence: local commits at phase boundaries (push only at ship gate). Repo moved OneDrive → `C:\dev\labelcheck` (shipshape's node_modules sync trap). **Rejected alternative**: single commit at ship — rejected for rollback safety and evaluator-readable history.
