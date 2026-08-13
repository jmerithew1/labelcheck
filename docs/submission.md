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

**Single check:** open the app → click **"Warning issue"** under *TRY A SAMPLE* (just below the upload box) → the check runs and renders: a red banner, the comparison list, and the Government warning panel showing Wording PASS but Formatting FAIL — the prefix is printed `Government Warning:` in title case, cited against 27 CFR 16.22(a)(2). (A brief spinner shows the failure being double-checked with a second reading; it resolves in a few seconds.) Click any comparison row (or "Show on label") to highlight where it sits on the label image. Try the other cards: a clean match, a genuine mismatch (the application says 40% while the label prints 47%), and a multiple-issues case. The formatting-tolerance behavior (case/punctuation = match, surfaced not failed) shows in the batch's case-diff rows, or download test "label 2" on the single-check page and pair it with ALL-CAPS fields. **Print report** produces a filing-ready copy (choose "Save as PDF" in the print window for a file).

**Batch:** open **Batch review** → click **"Load the sample batch"** — it loads and runs itself. Twelve labels stream into the table (filter chips with live counts). Note the split shifts once the bold measurement pass runs: rows still owing a bold glance sit in Needs review by design, so expect roughly half the batch there rather than the 10/2 an un-measured load shows; filter chips and search narrow the list; click a row to open the detail panel with the full evidence view and an **Audit trail** tab showing the real pipeline (including the second-reading confirmation on the warning failure — "health" should be "birth"). **Download report** exports the run as CSV. After the run, a measurement gate (stroke width + AI agreement; **not** infallible — worst-case 3 silent misses in 160 re-scored samples, 1.9%, see rubric C9) verifies bold on most labels automatically ("bold ✓ measured"); if any need a human glance, the **Confirm bold** strip appears on its own with just those warnings zoomed into a grid — confirm or flag each (flags move the row to Needs review), the strip disappears when done, and every decision exports in the CSV's `bold_check` column.

**Bring your own:** any label file (PNG/JPEG/WebP/PDF) + typed fields works in single check — the page links downloadable test labels if you have none. The batch dropzone takes the application CSV together with the label files (sample CSV and a ready-made zip bundle are linked under it).

## Measured, on the deployed URL

- Single label (with evidence highlighting): **p50 4.06 s**, worst **5.32 s** (n=6, current build) — requirement ~5 s. The median clears it; one run of six did not, and that is stated rather than rounded away.
- 250-label batch, **through the browser UI**: **2 min 26 s** (146.5 s), 250/250 completed, zero rate limits, zero errors, zero pairing issues. The server path alone measures 2 min 15 s. One honest caveat: past 60 rows the bold pass is opt-in, so all 250 rows land in *Needs review* until the agent clicks **Check bold type** — a row whose bold was never examined must not show a green tick.
