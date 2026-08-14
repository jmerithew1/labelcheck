# Submission — LabelCheck

| | |
|---|---|
| **Live app** | https://labelcheck-production-8f22.up.railway.app |
| **Repo** | this repository |
| **How to drive it** | [../README.md](../README.md#using-it) — every control, both pages |
| **Approach & trade-offs** | [approach.md](approach.md) |
| **Requirements → evidence** | [rubric.md](rubric.md) (every requirement, with file/test/measurement) |
| **Decision log** | [decisions.md](decisions.md) (each entry names the rejected alternative) |
| **Model benchmarks** | [spike-results.md](spike-results.md) · [measured-performance.json](measured-performance.json) |

## For the evaluator — 3 clicks, no data needed

**Single check.** Open the app → under *No label handy?* click **Warning issue**. The check runs against a real bundled label and comes back red: the banner and the badge in the top bar both say *Government warning fails*, and the Government warning panel splits it — *Wording* PASS, *Formatting* FAIL, because the prefix is printed `Government Warning:` in title case, cited against 27 CFR 16.22(a)(2). A brief spinner shows the failure being double-checked by a second, independent reading before it is asserted; while that runs the headline says *Double-checking*, not *fails*.

**To see where any value sits on the label, click its row** — anywhere on it; the Accept / Reject buttons keep their own presses. The viewer under it zooms (`−` / `+`, 50–250%), rotates, fits, opens full size, and pans by dragging above 100%.

Then try the other three cards: **Clean match** comes back fully green with nothing outstanding, **Mismatch** flags one field (the application says 40%, the label prints 47%), and **Multiple issues** flags two. On any flagged row, **Accept** re-files it as matched and records that a person looked; **Reject** confirms a real mismatch. The machine's finding stays visible underneath either way. At the foot of the result, **Audit trail** opens the pipeline for this label — which readers ran, their timing, whether a second reading was taken. **Print report** produces a filing-ready copy, and the trail is included in it whether or not it is open on screen.

**Batch.** Open **Batch review** → **Load the sample batch**. Twelve labels stream in and finish in about 13 seconds; filter chips carry live counts and problems sort to the top. Click a row to open the evidence panel — same comparison rows, same viewer, same warning panel as a single check, with decisions in the same places, plus an **Audit trail** tab showing the real pipeline for that label (including the second-reading confirmation on the warning failure — "health" should be "birth"). The panel footer carries the ruling on the whole label: **Accept label** / **Reject label**, which outranks every machine state and exports as `agent_review`.

Bold is the one check a computer cannot finish. A measurement gate (stroke width + ink density + AI agreement) resolves most labels by itself — **not infallible**: worst case 3 silent misses in 160 re-scored samples, 1.9%, see rubric C9. Whatever it cannot resolve appears on its own in the **Confirm bold** strip, showing just those warnings cropped and zoomed; hover one to magnify, then **Accept** or **Reject** — the same two words as every other decision — with an **Undo** on every decision. Rejects move the row to Needs review, and rows still being measured wait in a grey *Checking bold…* state rather than crowding the review queue. **Download report** exports the run as CSV carrying both the machine verdicts and your rulings.

**Bring your own.** Any label file (PNG/JPEG/WebP/PDF) plus typed fields works in single check — the page links downloadable test labels if you have none, and any *one* field is enough, because the government-warning check needs none of them. The batch dropzone takes the application CSV together with the label files; a ready-made zip bundle carrying both is linked under it, alongside the spreadsheet on its own for the format.

## Measured, on the deployed URL

- **Single label:** measured across **n=30** on the deployed app ([latency-p95.json](latency-p95.json)) — **p50 4.58 s, p90 5.36 s, p95 5.48 s, max 5.67 s, with 7 of 30 (23%) over five seconds**, against a ~5 s requirement. Earlier runs read p50 4.06 s / worst 5.32 s (n=6, [post-deskew-latency.json](post-deskew-latency.json)); six samples can give a median and a maximum but never a p95, which is why the larger run exists. Re-checked out of sample on **10 real approved TTB labels** — raw run committed in [latency-real-10.json](latency-real-10.json). The median clears the bar; the tail does not, and that is stated rather than rounded away.
- **250-label batch, through the browser UI:** **250/250 completed, 0 errors, 0 rate-limited, 0 pairing issues** ([batch-ui-250-postfix.json](batch-ui-250-postfix.json)). The app reported 139.1 s, against 146.5 s for an earlier independent run — both measured with the browser tab hidden, which suspends the renderer between interactions, so both are *active processing time* rather than foregrounded wall clock, and are recorded as approximate for that reason.
- **The bold pass:** runs for every batch (unified 2026-08-14 — it was opt-in past 60 rows before, which opened a 250-label batch with all 250 rows in *Needs review*). The measurement resolves about two thirds of eligible rows by itself and routes the rest to a human glance; rows still being measured sit in a grey *Checking bold…* state, never in Need review and never green. It is still the slowest thing in the app — client-side OCR, background minutes at 250 rows. (An earlier version of this line said "roughly three and a half minutes for a 250-label batch"; that was an arithmetic error — the measured 11.9 rows/min over 208 eligible rows is ~17.5 minutes, and the correction is recorded in [ocr-pool.json](ocr-pool.json) along with why that rate itself is suspect. The pane-visible re-measurement after unification is the current number.)
