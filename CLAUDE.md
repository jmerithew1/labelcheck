# LabelCheck — AI-Powered Alcohol Label Verification (take-home)

Take-home project: a standalone prototype that verifies alcohol label images against TTB application data. Full brief in [docs/brief.md](docs/brief.md) (extracted from the source docx in the same folder). Read it before scoping or building anything.

## Non-negotiables from the brief

- **~5 seconds per label** end-to-end, or agents won't use it. This kills slow multi-pass pipelines.
- **Batch upload** of 200–300 label applications is a first-class requirement, not a stretch goal.
- **Government warning check is exact**: word-for-word standard text, `GOVERNMENT WARNING:` in ALL CAPS and bold. Title case fails.
- **Everything else matches with judgment**: case/punctuation differences (`STONE'S THROW` vs `Stone's Throw`) are matches — surface them, don't fail them. Fuzzy/normalized comparison with a visible confidence or diff.
- **UI for non-technical users** — half the agent team is over 50; "something my mother could figure out." No hunting for buttons.
- **Standalone** — no COLA integration, nothing sensitive stored.
- Deliverables: repo with README + approach/assumptions doc, **and a deployed URL**. Working core > ambitious incomplete. Document trade-offs.

## Nice-to-haves (call out in writeup even if skipped)

- Tolerating imperfect photos (angle, glare, lighting).
- Acknowledge the client network blocks many outbound domains — a cloud-API prototype should note the on-prem/gov-cloud path.

## Status

- Repo initialized 2026-08-10; no code yet. No commits — commit only when asked.
