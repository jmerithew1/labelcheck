# Decisions — append-only, newest at top. Every entry names the rejected alternative.

## 2026-08-10 — v2.1 — plan review (Gate 2)

Cut standalone red team (injection neutralized by architecture, validated in spike; malformed-input QA folded into U2), spike expanded (burst, bold accuracy, injection), degradation ladder added, tracker contradiction resolved in favor of shipping the tracker. **Rejected alternative**: keeping 4c as a separate agent role — rejected because it validated a designed-in property and inflated Phase 4.

## 2026-08-10 — owner approvals at Gate 2

Commit cadence: local commits at phase boundaries (push only at ship gate). Repo moved OneDrive → `C:\dev\labelcheck` (shipshape's node_modules sync trap). **Rejected alternative**: single commit at ship — rejected for rollback safety and evaluator-readable history.
