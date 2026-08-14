# LabelCheck

AI-assisted verification of alcohol beverage label images against TTB application data — built as a take-home prototype. Upload a label image and the application's field values; LabelCheck reads the label, compares every field, runs the strict government-warning check, and shows the evidence side-by-side so a compliance agent can decide in seconds.

**Live app:** https://labelcheck-production-8f22.up.railway.app

## What it does

- **Single check (~5s):** application fields + label file (PNG/JPEG/WebP/PDF) → per-field comparison with character-level diffs and click-to-highlight evidence on the label image, plus a hard pass/fail on the Government Health Warning Statement (27 CFR Part 16).
- **Batch check:** a CSV of applications + their label images (built for 200–300 at a time) → results stream into a master-detail review table as each label finishes — filter chips with live counts (Matched / Need review / Not required) — one click narrows to "Need review" — search, and a per-row evidence panel with an audit trail. Exportable to CSV. Every batch row carries an audit-trail tab showing the real pipeline steps; a ready-made zip bundle (spreadsheet + labels) and the spreadsheet on its own are linked under the dropzone.
- **Judgment where judgment belongs:** `STONE'S THROW` vs `Stone's Throw` is a *match, surfaced with a note* — never an auto-rejection. The only hard FAIL language in the app belongs to the government warning, where the regulation is exact.
- **Try it in 3 clicks:** the home page bundles one-click samples (Clean match / Mismatch / Warning issue / Multiple issues) and the batch page has a "Load the sample batch" button — no data needed.

## Using it

Nothing needs to be set up to try it — both pages carry their own sample data.

### Try it with no data of your own

- **Single check** — under the upload box, *No label handy?* offers four one-click samples: **Clean match**, **Mismatch**, **Warning issue**, **Multiple issues**. Each one fills the application fields and runs a *real* check against a bundled label — the dot on the card is the colour that result actually comes back. Below them, *Need test files?* downloads three label images to upload yourself.
- **Batch review** — the empty state offers **Load the sample batch** (12 labels, runs immediately), plus a **sample bundle (zip)** containing the spreadsheet *and* its labels if you'd rather drive the upload yourself. The **spreadsheet only** download is there for the CSV format — on its own it will not run, because it names the labels rather than carrying them, and the app says so if you try.

### Single check

1. Type the application's values and drop the label file (PNG / JPG / WebP up to 8 MB, PDF up to 10 MB). They are typed rather than pulled in because the brief rules out COLA integration — there is no system of record for a standalone prototype to read, so the values come off the application on the agent's other screen. A 200–300 label surge never types anything: that arrives through the batch page as the CSV the applications already export. **Any one field is enough** — the government-warning check needs none of them, so a back label carrying only a bottler address is still worth checking. The optional **TTB application #** appears on the printed report.
2. **Check label.** The verdict lands in about five seconds. The badge in the top bar and the banner below it always say the same thing — they render from one shared summary, so they cannot disagree.
3. **To see where a value sits on the label, click its row** — anywhere on it. The Accept / Reject buttons keep their own presses, so clicking those records a decision instead. Rows reading *Not provided* have nothing to locate and stay inert.
4. **The label viewer**: `−` / `+` zoom in 25% steps (50%–250%), **Rotate** turns 90° a click, **Fit** resets both, **View full size** opens a lightbox that keeps the highlight overlays. Above 100% the image pans — drag it.
5. **Flagged rows carry Accept / Reject.** *Accept* re-files the row as matched and records that a person looked; *Reject* confirms a real mismatch. Either way the machine's original finding stays on the row and on the printed report — a ruling is layered over a verdict, never a replacement for one.
6. **The government warning has its own panel**, split into *Wording* (word-for-word against 27 CFR 16.21) and *Formatting* (ALL CAPS, and bold). Bold is the one check a computer cannot finish: where the stroke-width measurement is confident it resolves itself and says so, and where it is not, the Formatting row grows the same **Accept** / **Reject** pair. Rejecting bold is a warning failure, and the whole screen turns red to match.
7. **Audit trail** sits collapsed at the foot of the result: which readers ran, how long they took, whether a second reading was taken, and what was finally recorded. It opens on click and is always included in the printed copy, whether or not it is open on screen.
8. **Print report** produces a printable record — choose *Save as PDF* in the print dialog for a file. **Check another label** resets the form.

### Batch review

1. Drop the CSV together with the label files. Rows pair to files by name; anything unpaired is named by its CSV row number *before* the run starts, and a batch with pairing problems waits for you rather than auto-running. Bad CSV encoding and missing columns are reported in plain language rather than as mismatches.
2. Results stream in as each label finishes. **Filter chips** carry live counts (All / Matched / Need review / Not required) and problems sort to the top when the run ends. **Search** filters by file name or brand. Keyboard: `↑` `↓` to move, `Enter` to open, `Esc` to close.
3. **Click a row to open the evidence panel.** It holds the same comparison rows, label viewer and warning panel as a single check, and decisions are made in the same places — flagged fields on their own rows, bold on the Formatting row. The **Audit trail** tab shows the real pipeline steps for that label.
4. **The panel footer carries the ruling on the whole label**: **Accept label** re-files the row as Matched, **Reject label** keeps it in review as your confirmed finding. It outranks every machine state and exports as `agent_review`. A row with nothing outstanding says so instead of asking, with a quiet **Disagree?** to override anyway. **Review next** steps to the next row and stops at the end rather than looping.
5. **Confirm bold** appears by itself when labels still need a human glance, showing only those rows as cropped warning images — hover one to magnify it, then **Looks bold** or **Not bold**; every decision offers an **Undo**. Past 60 rows the measurement pass is opt-in behind **Check bold type**, so a 250-label dump costs nothing until you ask for it.
6. **Download report (CSV)** exports every row with both the machine verdicts and your rulings (`agent_review`, `bold_check`). Nothing is stored server-side — the exported report is the durable record, which is why **+ New batch** asks before discarding results you haven't downloaded.

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
| [docs/submission.md](docs/submission.md) | **Start here** — the evaluator walkthrough: what to click, in order, and what each screen proves |
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
