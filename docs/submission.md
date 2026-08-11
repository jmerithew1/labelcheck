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

**Single check:** open the app → click **"Warning failure"** under *Try an example* → the check runs and renders: a red banner, the comparison list, and the Government warning panel showing Wording PASS but Formatting FAIL — the prefix is printed `Government Warning:` in title case, cited against 27 CFR 16.22(a)(2). Click any comparison row (or "Show on label") to highlight where it sits on the label image. Try the other examples for a clean match and a formatting-differences match (`45%` vs `45% Alc./Vol. (90 Proof)` — same thing, surfaced not failed). **Download report** prints a filing-ready copy.

**Batch:** open **Batch review** → click **"Run the sample batch"** — it loads and runs itself. Twelve labels stream into the table (summary tiles: 10 matched · 2 need review); filter chips and search narrow the list; click a row to open the detail panel with the full evidence view and an **Audit trail** tab showing the real pipeline (including the second-reading confirmation on the warning failure — "health" should be "birth"). **Download report** exports the run as CSV.

**Bring your own:** any label file (PNG/JPEG/WebP/PDF) + typed fields works in single check — the page links downloadable test labels if you have none. The batch dropzone takes the application CSV together with the label files (sample CSV and a ready-made zip bundle are linked under it).

## Measured, on the deployed URL

- Single label (with evidence highlighting): **p50 4.3 s** (worst 4.5 s, n=6) — requirement ~5 s
- 250-label batch: **2 min 15 s**, 250/250 succeeded, zero rate limits, zero errors
