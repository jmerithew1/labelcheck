# LabelCheck

AI-assisted verification of alcohol beverage label images against TTB application data — built as a take-home prototype. Upload a label image and the application's field values; LabelCheck reads the label, compares every field, runs the strict government-warning check, and shows the evidence side-by-side so a compliance agent can decide in seconds.

**Live app:** https://labelcheck-production-8f22.up.railway.app

## What it does

- **Single check (~4s):** application fields + label file (PNG/JPEG/WebP/PDF) → per-field comparison with character-level diffs and click-to-highlight evidence on the label image, plus a hard pass/fail on the Government Health Warning Statement (27 CFR Part 16).
- **Batch check:** a CSV of applications + their label images (built for 200–300 at a time) → results stream into a master-detail review table as each label finishes — filter chips with live counts (Matched / Need review / Not required) — one click narrows to "Need review" — search, and a per-row evidence panel with an audit trail. Exportable to CSV. Every batch row carries an audit-trail tab showing the real pipeline steps; a sample CSV and ready-made zip bundle are linked under the dropzone.
- **Judgment where judgment belongs:** `STONE'S THROW` vs `Stone's Throw` is a *match, surfaced with a note* — never an auto-rejection. The only hard FAIL language in the app belongs to the government warning, where the regulation is exact.
- **Try it in 3 clicks:** the home page bundles one-click samples (Clean match / Mismatch / Warning issue / Multiple issues) and the batch page has a "Load the sample batch" button — no data needed.

## Run it locally

Requires Node.js 20+ and an Anthropic API key.

```bash
git clone <this repo>
cd labelcheck
npm install
cp .env.example .env.local   # then put your real key in .env.local
npm run dev                  # http://localhost:3000
```

Tests (comparison engine — every rubric example is a test case):

```bash
npm test
```

## How it works (one paragraph)

One vision call per label does **perception only**: Claude Haiku 4.5 transcribes exactly what is printed — verbatim, casing preserved, tri-state per field (`found` / `absent` / `unreadable`) — while Claude Sonnet 5 concurrently judges one thing transcription can't capture: whether the warning prefix is printed in bold. **Every verdict is computed in deterministic, unit-tested TypeScript** ([lib/compare](lib/compare)): exact word-for-word comparison against the canonical 27 CFR 16.21 text, an ALL-CAPS check on exactly the words `GOVERNMENT WARNING`, numeric comparison for alcohol content (`45% Alc./Vol. (90 Proof)` ≡ `45%`, proof cross-checked as 2×ABV) and net contents (`750 mL` ≡ `75 cl`), and normalized fuzzy matching with visible diffs for text fields. The model is never asked "does it match?" — models normalize; code doesn't.

## Documentation

| Doc | What's in it |
|---|---|
| [docs/approach.md](docs/approach.md) | Architecture, measured results, trade-offs, limitations, deployment path for restricted networks |
| [docs/spike-results.md](docs/spike-results.md) | Day-1 model benchmarks that drove the architecture (fidelity, latency, burst, bold accuracy) |
| [docs/rubric.md](docs/rubric.md) | Every requirement from the brief, tracked with evidence |
| [docs/decisions.md](docs/decisions.md) | Append-only decision log — every entry names the rejected alternative |
| [docs/brief.md](docs/brief.md) | The original assignment brief |

## Sample data

[samples/labels](samples/labels) holds 18 rendered test labels with exact ground-truth sidecars — including adversarial cases (swapped words, dropped words, punctuation drift, title-case prefix, non-bold prefix, printed prompt-injection text). [samples/batch](samples/batch) is a ready-to-run 12-row batch. To regenerate: `cd samples/tools && npm install && node render.mjs` (the generator has its own dependencies, including a browser download — not installed by the root `npm install`).
