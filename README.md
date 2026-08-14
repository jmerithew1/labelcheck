# LabelCheck

AI-assisted verification of alcohol beverage label images against TTB application data — built as a take-home prototype. Upload a label image and the application's field values; LabelCheck reads the label, compares every field, runs the strict government-warning check, and shows the evidence side-by-side so a compliance agent can decide in seconds.

**Live app:** https://labelcheck-production-8f22.up.railway.app

## What it does

- **Single check (~5s):** application fields + label file (PNG/JPEG/WebP/PDF) → per-field comparison with character-level diffs and click-to-highlight evidence on the label image, plus a hard pass/fail on the Government Health Warning Statement (27 CFR Part 16).
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

[samples/labels](samples/labels) holds 35 rendered test labels with exact ground-truth sidecars — including adversarial cases (swapped words, dropped words, punctuation drift, title-case prefix, non-bold prefix, printed prompt-injection text). [samples/batch](samples/batch) is a ready-to-run 12-row batch, and [samples/demo](samples/demo) holds the degraded photo-condition variants the home page's sample cards actually serve. To regenerate: `cd samples/tools && npm install && node render.mjs` (the generator has its own dependencies, including a browser download — not installed by the root `npm install`).

### Measurement harnesses

The twenty scripts in `samples/tools` are the measurement rig behind every number in the docs. Generated images are gitignored and regenerable — the scored summaries in `docs/*.json` are the evidence. All default to `http://localhost:3000`; pass a URL to target a deployment.

| Script | Measures | Writes |
|---|---|---|
| `render.mjs` | Generates the 35 ground-truthed labels + sidecars + the 12-row sample batch | `samples/labels`, `samples/batch` |
| `pick-demo-samples.mjs` | Chooses which degraded variant each demo card and download serves, validated against the measured verdicts | `samples/demo` + its manifest |
| `make-sample-zip.mjs` | Rebuilds the downloadable sample bundle from what is actually on disk, so it cannot drift from `batch.csv` | `samples/batch/sample-batch.zip` |
| `robustness-matrix.mjs` | 34 scoreable labels × 40 degradation conditions; false rejections vs missed violations | `docs/robustness-matrix.json` |
| `degrade.mjs` / `degrade-hard.mjs` | Smaller degradation sets (the original 15, and a harder 40) | `docs/degraded-hard.json` |
| `enhance-ab.mjs` | Whether the pre-read deskew actually converts amber angled labels into confirmed-clean ones | `docs/enhance-ab.json` |
| `enhance-skew-audit.mjs` | The opposite risk: that the deskew spuriously rotates an already-straight label. Zero API cost | `docs/enhance-skew-audit.json` |
| `harvest-ttb.mjs` | Downloads real approved labels from TTB's public COLA registry | `samples/real/` + its manifest |
| `score-real.mjs` | Scores those real labels; an approved COLA is compliant, so any warning failure is a false rejection | `docs/real-labels.json` |
| `contact-sheet.mjs` | Labelled grids so many images can be triaged by eye at once | `samples/real/_sheets` |
| `bold-gate-rescore.mjs` | Re-scores bold through the shipped pixel gate offline, no API calls | `docs/bold-gate-rescore.json` |
| `bold-gate-shipped-path.mjs` | The gate through the path the app *really* runs — real located bands, sampled repeatedly, because the band moves between runs | stdout (used to choose demo images) |
| `locate-band-audit.mjs` | How often a located warning band actually contains the warning, on real TTB labels | stdout |
| `bold-densitometry-spike.mjs` | First pass at measuring bold from ink density | `docs/bold-densitometry-spike.json` |
| `bold-densitometry-matrix.mjs` | Density across fonts — the run that showed typeface confounds weight | `matrix-out/` → `docs/bold-densitometry-matrix.json` |
| `bold-multisignal-spike.mjs` | Round 1 of the bold gate loop | `multisignal-out/` → `docs/bold-multisignal-r1.json` |
| `bold-multisignal-r2.mjs` | Round 2 — **the thresholds in `lib/compare/boldGate.ts` trace to this run** | `multisignal-r2-out/` → `docs/bold-multisignal-r2.json` |
| `bold-multisignal-r3.mjs` | Round 3 — rejected as overfit; kept as the audit trail for why the gate stopped at r2 | `multisignal-r3-out/` → `docs/bold-multisignal-r3.json` |
| `bold-croplens.mjs` | Crop-lens variant — rejected on a validation mistake | `croplens-out/` → `docs/bold-croplens-results.json` |

The five `bold-*` rounds write into gitignored `*-out/` directories; their committed `docs/` copies were placed there by hand, so re-running one does not refresh the committed evidence.
