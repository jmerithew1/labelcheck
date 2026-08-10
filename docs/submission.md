# Submission — LabelCheck

| | |
|---|---|
| **Live app** | https://labelcheck-production-8f22.up.railway.app |
| **Repo** | this repository |
| **Approach & trade-offs** | [approach.md](approach.md) |
| **Requirements → evidence** | [rubric.md](rubric.md) (every requirement, with file/test/measurement) |
| **Decision log** | [decisions.md](decisions.md) (each entry names the rejected alternative) |
| **Model benchmarks** | [spike-results.md](spike-results.md) · [measured-performance.json](measured-performance.json) |

## For the evaluator — 3 clicks, no data needed

**Single check:** open the app → click **"Warning failure"** under *Try a sample* → the check runs and renders: the label fails because its warning prefix is printed `Government Warning:` in title case, with the exact deviation and the CFR citation, while all four fields show as matches. Try the other two samples for a clean match and a formatting-differences match (`45%` vs `45% Alc./Vol. (90 Proof)` — same thing, surfaced not failed).

**Batch:** click **"Check a batch →"** → **"Or run the sample batch"** → **"Check all labels"**. Twelve labels stream in over ~10 seconds; the summary strip reads the triage ("10 clean · 1 need a look · 1 warning failures"), exceptions sort to the top, clean matches collapse. Click **Open** on the warning failure to see the word-swap caught ("health" should be "birth"). **Download results (CSV)** exports the run.

**Bring your own:** any label photo (PNG/JPEG/WebP) + typed fields works in single check; the batch page links a sample CSV defining the manifest format.

## Measured, on the deployed URL

- Single label: **p50 4.0 s** (worst 4.4 s, n=7) — requirement ~5 s
- 250-label batch: **2 min 01 s**, 250/250 succeeded, zero rate limits
