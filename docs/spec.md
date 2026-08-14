# Build: LabelCheck

Synthesized from three-lens scoping (economics / psychology / technology), 2026-08-10.
Requirements tracked in [rubric.md](rubric.md) — any missed hard requirement is an auto-fail.

> **This is the original build spec, kept as a record of what was planned.** Where it and the shipped app differ, the app and [approach.md](approach.md) are current — notably: perception is now *two* parallel model calls (Haiku transcribes, Sonnet judges bold) rather than one, XLSX manifests were cut to CSV only, and bold is resolved by a measured multi-signal gate rather than an unaided model judgment.

**Outcome:** A TTB compliance agent uploads a label image (or a batch of 200–300) plus the application data, and in ~5 seconds per label gets evidence they can verify at a glance — per-field comparisons with diffs, and a deterministic pass/fail on the government warning.

**For:** TTB compliance agents (half over 50, some skeptical of AI) triaging routine label applications — and the evaluator who opens the deployed URL owning zero test data.

## Architecture (one paragraph)

One vision-LLM call per label (Claude, strict JSON schema output): the model does *perception only* — verbatim transcription preserving exact case, tri-state per field (`found` / `absent` / `unreadable`), plus a `warning_prefix_bold` visual judgment with confidence. All verdicts happen in deterministic code: exact string compare of the warning against canonical 27 CFR 16.21 text, ALL-CAPS check on the `GOVERNMENT WARNING:` prefix, normalized fuzzy matching (casefold, punctuation-strip, similarity score) for brand/class/ABV/net contents. The model is never asked "does it match?" — LLMs normalize casing, which would silently break the exact-warning requirement. Batch = bounded concurrency (~10–20 parallel calls) on the standard Messages API with live streaming results; 300 labels ≈ 1–2 min wall-clock. Images downscaled to ≤1568px long edge before sending.

## In scope

1. **Single check**: form fields (brand, class/type, alcohol content, net contents) + image drop zone → results in ~5s.
2. **Batch check**: CSV/XLSX manifest (one row per application) + images paired by filename; downloadable sample CSV; live per-row progress ("137 of 250 checked"), rows appear as they finish.
3. **Results screen (the product)**: side-by-side label image + per-field comparison table (application value vs what the AI read), character-level diff for near-matches. Verdict language: "Match" / "Match — formatting differs" / "Possible mismatch — check". Hard "FAILS — must be exact" only for the government warning, with the exact deviation highlighted. Status = word + icon, never color alone.
4. **Batch triage view**: summary strip ("212 clean · 31 need a look · 7 warning failures"), exceptions sorted to top, clean matches collapsed; click any row → side-by-side detail.
5. **Bundled sample data**: "Try a sample" with 3 pairs (clean match / case-difference match / warning failure) + a pre-built sample batch, so every behavior is demonstrable in three clicks with no evaluator-supplied data. AI-generated test labels (brief encourages this).
6. **Loud failure handling**: not-a-label guard, unreadable-vs-missing distinction, API refusal/error handling, human-readable errors.
7. **Deploy day one**: walking skeleton on a long-running container host (Railway/Fly/Render), API key server-side only. URL is never at risk at 11pm.
8. **Docs**: README (setup/run), approach/assumptions doc with trade-offs, on-prem/gov-cloud path (Azure OpenAI / Bedrock GovCloud) for the blocked-network concern, deferred photo-tolerance plan.

## Explicitly out of scope

- Database, auth, persistence of any kind ("nothing sensitive stored" makes this a feature — document it).
- OCR/Tesseract or any multi-pass extraction pipeline (the 30–40s vendor-pilot trap).
- Message Batches API (no wall-clock guarantee; fatal for live triage despite 50% discount).
- COLA integration (brief forbids), photo-imperfection tolerance (stretch — writeup paragraph instead), external queue infra, high-res vision mode.

## Acceptance criteria

- All hard-requirement rows in [rubric.md](rubric.md) (D1–D4, C1–C11, P1–P3, U1–U3, S1–S2) check off with evidence.
- Measured single-label latency ≤ ~5s on the deployed URL.
- 250+ batch completes ≤ ~3 min wall-clock with live progress; triage view answers "which ones do I look at?" without scrolling past clean rows.
- Title-case "Government Warning:" fails loudly with the deviation shown; `STONE'S THROW` vs `Stone's Throw` shows as a match with a formatting note.
- Evaluator can demo every core behavior in 3 clicks from a cold visit using bundled samples.

## Known failure modes

- Model normalizes casing in transcription → exact check silently passes bad labels. Mitigation: verbatim-transcription prompting + spike test before build (see riskiest assumption); worst case, fall back to character-level verification prompt design.
- Rate limits stall batch → bounded semaphore + SDK backoff + downscaled images.
- Blurry/glare image → `unreadable` state surfaced as "check manually," never conflated with `absent` (false rejections are how we lose Dave Morrison).
- Odd upload triggers model refusal (`stop_reason: "refusal"`) → caught, shown as human-readable error.
- Serverless function timeouts during batch → avoided by choosing a container host.

## Riskiest assumption

**A vision LLM, properly prompted, transcribes the government warning verbatim with exact casing preserved (doesn't "helpfully" normalize `Government Warning:` to `GOVERNMENT WARNING:` or vice versa).** If wrong, the deterministic exact check is checking fabricated text and the strictest requirement silently breaks. De-risk with a 30-minute spike before the build plan: test labels with title-case warnings, altered wording, and correct warnings through the real prompt+schema; verify transcription fidelity.

## Open decisions (with chosen default)

- **Stack**: Next.js (App Router) as a standalone Node server in one container on Railway — one codebase, API routes + SSE for batch progress, trivially deployable. Unless told otherwise.
- **Model**: default Sonnet-tier (`claude-sonnet-5`) for transcription fidelity on stylized label type; drop to Haiku 4.5 only if measured latency demands it. Benchmark both in the spike.
- **Bold detection**: model visual judgment (`warning_prefix_bold` + confidence), surfaced in UI as an AI judgment, limitation documented. No deterministic alternative exists without typography analysis that would blow the latency budget.
- **Batch pairing**: images matched to CSV rows by filename column; mismatches reported loudly, not skipped.
- **Cold critic**: recommended — the riskiest assumption is load-bearing and the warning check is the single most likely place to lose the take-home.
