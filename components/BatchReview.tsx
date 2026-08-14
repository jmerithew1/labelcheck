"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CheckResult } from "@/lib/compare/index.ts";
import type { LabelExtraction } from "@/lib/vision/contract.ts";
import type { Bands } from "@/lib/vision/locate.ts";
import { parseCsv, toCsv } from "@/lib/csv.ts";
import { prepareImage } from "@/lib/downscale.ts";
import { applyBoldGate, type BoldGateResult } from "@/lib/compare/boldGate.ts";
import { measureBoldSignals, ocrWarningBand } from "@/lib/boldMeasure.ts";
import { DecidePair, ResultView, type FieldDecision } from "./ResultView.tsx";
import { boldEligible, boldPendingRow, bucketOf, redFields, resolvedByFieldReview, type Bucket } from "@/lib/batchTriage.ts";
import { AuditTrail } from "./AuditTrail.tsx";
import { CheckingCard } from "./CheckingCard.tsx";
import { Shell } from "./Shell.tsx";

/** v2 batch review (design §5/§6): empty-state card → legend + filter chips
 *  with always-tinted counts + search → table per column spec with a DOCKED
 *  sticky detail panel (sidebar collapses while it's open). Keyboard: ↑↓
 *  move, Enter opens, Esc closes. All rows are real checks over the CSV
 *  pairing model; the audit trail shows the real pipeline. */

const CONCURRENCY = 8;
const PAGE_SIZE = 10;
const REQUIRED_HEADERS = ["filename", "brand_name", "class_type", "alcohol_content", "net_contents"];

const HEADER_SYNONYMS: Record<string, string> = {
  filename: "filename", file: "filename", "file name": "filename", image: "filename", label: "filename",
  brand_name: "brand_name", brand: "brand_name", "brand name": "brand_name",
  class_type: "class_type", class: "class_type", type: "class_type", "class type": "class_type", "class/type": "class_type",
  alcohol_content: "alcohol_content", alcohol: "alcohol_content", "alcohol content": "alcohol_content", abv: "alcohol_content",
  net_contents: "net_contents", net: "net_contents", "net contents": "net_contents", volume: "net_contents",
  bottler_name_address: "bottler_name_address", bottler: "bottler_name_address", "bottler name & address": "bottler_name_address",
  country_of_origin: "country_of_origin", country: "country_of_origin", origin: "country_of_origin", "country of origin": "country_of_origin",
};
const canonicalHeader = (h: string) => HEADER_SYNONYMS[h.trim().toLowerCase()] ?? h.trim().toLowerCase();

type RowStatus = "queued" | "checking" | "done" | "error";

interface BatchRow {
  index: number;
  filename: string;
  application: Record<string, string>;
  file?: File;
  status: RowStatus;
  result?: CheckResult;
  extraction?: LabelExtraction;
  bands?: Bands;
  ms?: number;
  checkedAt?: Date;
  error?: string;
  imageUrl?: string;
  /** Human bold spot-check: confirmed = glanced and looks bold; flagged =
   *  glanced and does NOT look bold (moves the row to Needs review). */
  boldReview?: "confirmed" | "flagged";
  /** Machine gate result (multi-signal; worst case 3 silent misses in 160
   *  re-scored samples — see rubric C9, not zero): "bold" auto-resolves the
   *  glance, "not_bold" escalates to review, "human" = measured but
   *  inconclusive. A human decision always wins. */
  boldAuto?: BoldGateResult;
  /** The agent's ruling after reviewing the row: "ok" re-files it as
   *  Matched (shown as "Accepted ✓"), "correction" keeps it in review as a
   *  confirmed problem. Outranks every machine state. */
  agentReview?: "ok" | "correction";
  /** Per-field rulings on flagged comparison rows (rendered by ResultView).
   *  When every flagged field is accepted, the row resolves on its own —
   *  the explicit agentReview above still outranks. */
  fieldReview?: Partial<Record<string, FieldDecision>>;
  /** imageUrl already points at the PREPARED (deskewed/downscaled) image —
   *  the geometry the located bands and bold measurement live in. */
  prepared?: boolean;
  /** the warning band has had its one OCR correction attempt (whether or not
   *  it succeeded) — stops the fallback from retrying forever */
  bandFixed?: boolean;
}

/** Shared control styles so every button in the table area reads as one
 *  system: chip-style toggles (tinted when active) and quiet secondaries. */
const CTRL_BASE =
  "flex h-8 items-center gap-1.5 rounded-[7px] border px-3 text-[12.5px] font-semibold transition disabled:opacity-40";
const CTRL_IDLE = "border-line bg-card text-ink-2 hover:bg-line-soft";
const CTRL_ON = {
  green: "border-green bg-green-tint text-green",
  amber: "border-amber bg-amber-tint text-amber",
  red: "border-red bg-red-tint text-red",
  navy: "border-navy bg-select text-navy",
} as const;


const fmtTime = (d: Date) =>
  d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function rowSummary(r: BatchRow): React.ReactNode {
  if (r.status === "error") return <span className="font-semibold text-red">{r.error ?? "Error"}</span>;
  if (!r.result) return <span className="text-muted-2">{r.status === "checking" ? "Checking…" : "Waiting"}</span>;
  let matched = 0, mismatch = 0, review = 0, notRequired = 0, accepted = 0;
  for (const f of r.result.fields) {
    if (f.verdict === "match" || f.verdict === "match_formatting") matched++;
    else if (f.verdict === "possible_mismatch" || f.verdict === "absent_on_label") {
      if (r.fieldReview?.[f.field] === "accepted") accepted++;
      else mismatch++;
    }
    else if (f.verdict === "unreadable") review++;
    else notRequired++;
  }
  if (r.result.warning.verdict.startsWith("fail")) mismatch++;
  else if (r.result.warning.verdict === "unreadable") review++;
  // The bold-confirm marker stays in batch summaries — the tool's one blind
  // spot never hides behind a clean-looking row (behavioral audit finding).
  // It resolves only when a human glances: confirmed clears it, flagged
  // escalates it.
  // While the gate is still measuring a row, say nothing about bold — the
  // status dot already reads Matched, and asking for a glance the machine
  // may be about to resolve makes one row contradict itself.
  const boldState = !boldEligible(r)
    ? null
    : r.boldReview ??
      (r.boldAuto === undefined ? null : r.boldAuto === "bold" ? "auto" : r.boldAuto === "not_bold" ? "auto_flag" : "confirm");
  const sep = <span className="text-muted-2"> • </span>;
  return (
    <>
      <span>{matched} matched</span>
      {accepted > 0 && (<>{sep}<span className="font-semibold text-green">{accepted} accepted by you</span></>)}
      {mismatch > 0 && (<>{sep}<span className="font-semibold text-red">{mismatch} mismatch{mismatch === 1 ? "" : "es"}</span></>)}
      {review > 0 && (<>{sep}<span className="font-semibold text-amber">{review} review</span></>)}
      {boldState === "confirm" && (<>{sep}<span className="text-amber">bold: confirm</span></>)}
      {boldState === "confirmed" && (<>{sep}<span className="text-green">bold ✓</span></>)}
      {boldState === "auto" && (<>{sep}<span className="text-green">bold ✓ measured</span></>)}
      {boldState === "auto_flag" && (<>{sep}<span className="font-semibold text-amber">bold: check</span></>)}
      {boldState === "flagged" && (<>{sep}<span className="font-semibold text-red">bold: flagged</span></>)}
      {notRequired > 0 && (<>{sep}<span className="text-muted-2">{notRequired} not required</span></>)}
    </>
  );
}

export function BatchReview() {
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [pairingIssues, setPairingIssues] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | Bucket>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [openRow, setOpenRow] = useState<number | null>(null);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [tab, setTab] = useState<"overview" | "audit">("overview");
  const [wallMs, setWallMs] = useState<number | null>(null);
  const [autoRun, setAutoRun] = useState(false);
  const [savedToast, setSavedToast] = useState(false);
  const [exportedSince, setExportedSince] = useState(false);
  const [visited, setVisited] = useState<Set<number>>(new Set());
  // The strip is attention-driven: it appears on its own when rows need a
  // human glance and disappears when nothing does. Dismiss hides it until
  // the pending set changes again.
  const [stripDismissed, setStripDismissed] = useState(false);
  // Below xl the detail panel renders inline BELOW the table, so opening a
  // row from the strip (or a row far down the list) can land off-screen and
  // look like nothing happened. Scroll it into view when it opens.
  const inlinePanelRef = useRef<HTMLElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const startedAt = useRef(0);

  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (running || rows.some((r) => r.status === "done")) e.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [running, rows]);

  useEffect(() => {
    if (autoRun && rows.some((r) => r.status === "queued") && !running) {
      setAutoRun(false);
      void run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, rows]);

  // Every batch gets a generation number. Late band-repair and bold-gate
  // responses write back by ROW INDEX, which restarts at 0 for each batch —
  // without this a stale band or bold verdict from the previous batch could
  // land on an unrelated label.
  const batchGen = useRef(0);
  function resetBatchState() {
    batchGen.current++;
    gateRunning.current.clear();
    preparedIdx.current.clear();
    bandFixing.current.clear();
    setStripDismissed(false);
    setBoldUndo(null);
    setFilter("all");
    setSearch("");
    setSelectedRow(null);
  }

  function buildRows(csvText: string, images: File[]) {
    resetBatchState();
    setRows((old) => {
      for (const r of old) if (r.imageUrl) URL.revokeObjectURL(r.imageUrl);
      return old;
    });
    const parsed = parseCsv(csvText);
    if (!parsed.length) { setGlobalError("The spreadsheet file is empty."); return false; }
    const headers = parsed[0].map(canonicalHeader);
    const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
    if (missing.length) {
      setGlobalError(`The spreadsheet is missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ").replace(/_/g, " ")}. Download the sample CSV to see the expected format.`);
      return false;
    }
    if (parsed.length === 1) {
      setGlobalError(
        "The spreadsheet has column headings but no label rows under them. Add one row per label — the file name in the first column must match an uploaded label file.",
      );
      return false;
    }
    // U+FFFD means the file was not UTF-8 and characters were destroyed in
    // decoding. Left alone, "Añejo" becomes "aejo" and the tool reports a
    // mismatch against a perfectly good label — sending the agent hunting a
    // defect that does not exist.
    if (csvText.includes("�")) {
      setGlobalError(
        "The spreadsheet isn't saved as UTF-8, so accented characters (é, ñ, ü) arrived damaged and would be reported as mismatches. Re-save it as CSV UTF-8 and upload it again.",
      );
      return false;
    }
    setGlobalError(null);
    const issues: string[] = [];
    const imageMap = new Map<string, File>();
    const stem = (n: string) => n.toLowerCase().replace(/\.\w+$/, "");
    for (const f of images) {
      const key = stem(f.name);
      const clash = imageMap.get(key);
      if (clash) {
        // Matching is by name WITHOUT extension, so photo.png and photo.jpg
        // collide. Say that, rather than claiming two files share a name when
        // they visibly don't.
        issues.push(
          clash.name.toLowerCase() === f.name.toLowerCase()
            ? `Two files share the name "${f.name}" — using the first.`
            : `"${f.name}" and "${clash.name}" match the same CSV row (labels pair by file name without the extension) — using "${clash.name}".`,
        );
      } else imageMap.set(key, f);
    }
    const newRows: BatchRow[] = parsed.slice(1).map((cells, i) => {
      const rec: Record<string, string> = {};
      headers.forEach((h, j) => (rec[h] = (cells[j] ?? "").trim()));
      const file = imageMap.get(stem(rec.filename ?? ""));
      if (!file) issues.push(`Row ${i + 2}: no label file found for "${rec.filename}".`);
      // Same guard the single page's Check button applies: a row with every
      // application cell blank would be a guaranteed 400 from the server —
      // catch it here as a pairing-style issue instead of burning a check
      // slot to learn it and surfacing a generic per-row error.
      const anyValue = ["brand_name", "class_type", "alcohol_content", "net_contents", "bottler_name_address", "country_of_origin"]
        .some((k) => (rec[k] ?? "").trim());
      if (file && !anyValue) issues.push(`Row ${i + 2} ("${rec.filename}"): every application field is blank — fill in at least one value to compare against.`);
      return {
        index: i,
        filename: rec.filename ?? "",
        application: rec,
        file,
        status: file ? ("queued" as const) : ("error" as const),
        error: file ? undefined : "No matching label file uploaded",
        imageUrl: file ? URL.createObjectURL(file) : undefined,
      };
    });
    const used = new Set(newRows.map((r) => stem(r.filename)));
    for (const f of images) if (!used.has(stem(f.name))) issues.push(`File "${f.name}" has no CSV row — skipped.`);
    setPairingIssues(issues);
    setRows(newRows);
    setWallMs(null);
    setPage(0);
    setOpenRow(null);
    return issues.length === 0 && newRows.length > 0;
  }

  async function onFiles(list: File[]) {
    const csv = list.find((f) => f.name.toLowerCase().endsWith(".csv"));
    const media = list.filter((f) => /^image\/|application\/pdf/.test(f.type));
    if (!csv) {
      setGlobalError("Include the spreadsheet (CSV) along with the label files — one row per application; labels are matched to rows by file name.");
      return;
    }
    // The mirror case, and the one people actually hit: the spreadsheet arrives
    // with no labels at all. Downloading "sample CSV" and dropping it in is the
    // obvious thing to try, and it used to build a row per application and fail
    // every one of them — a wall of red saying "No matching label file uploaded"
    // twelve times for a mistake that takes one sentence to explain. The
    // per-row pairing errors stay right when SOME labels are missing; they are
    // just the wrong way to say "you brought no labels at all".
    if (!media.length) {
      setGlobalError(
        "That’s the spreadsheet on its own — it lists the labels but doesn’t contain them. Drop the label files in with it, or press “Load the sample batch” to run the bundled example, or download the sample bundle (zip), which has the spreadsheet and its labels together.",
      );
      return;
    }
    const clean = buildRows(await csv.text(), media);
    if (clean) setAutoRun(true);
  }

  async function loadSampleBatch() {
    setGlobalError(null);
    setRows([]);
    try {
      const csvRes = await fetch("/api/batch-samples/batch.csv");
      if (!csvRes.ok) { setGlobalError("Could not load the sample batch. Refresh and try again."); return; }
      const csvText = await csvRes.text();
      const filenames = parseCsv(csvText).slice(1).map((r) => r[0]?.trim()).filter(Boolean);
      const images = await Promise.all(
        filenames.map(async (n) => {
          const res = await fetch(`/api/batch-samples/${n}`);
          if (!res.ok) throw new Error(`sample ${n} unavailable`);
          return new File([await res.blob()], n, { type: "image/png" });
        }),
      );
      buildRows(csvText, images);
      setAutoRun(true);
    } catch {
      setGlobalError("Could not load the sample batch. Check your connection and try again.");
    }
  }

  async function run() {
    setRunning(true);
    startedAt.current = performance.now();
    const queue = rows.filter((r) => r.status === "queued" || (r.status === "error" && r.file));
    let next = 0;
    const update = (index: number, patch: Partial<BatchRow>) =>
      setRows((rs) => rs.map((r) => (r.index === index ? { ...r, ...patch } : r)));
    async function worker() {
      while (true) {
        const i = next++;
        if (i >= queue.length) return;
        const row = queue[i];
        update(row.index, { status: "checking", error: undefined });
        try {
          const small = row.file!.type === "application/pdf" ? row.file! : await prepareImage(row.file!);
          swapPreparedUrl(row.index, small, row.file);
          const form = new FormData();
          form.set("image", small);
          // No skip_locate: the batch runs the same check a single upload
          // does, so evidence bands arrive WITH the verdict from the same
          // parallel locator call (p50 ~2s, hidden inside the main call's
          // ~3.8s window). The old flow suppressed bands here and refetched
          // them serially through /api/locate after the run — a second
          // process for the same job, and the reason the bold pass over a
          // large batch was slow enough to be made opt-in at all.
          for (const k of ["brand_name", "class_type", "alcohol_content", "net_contents", "bottler_name_address", "country_of_origin"]) {
            form.set(k, row.application[k] ?? "");
          }
          const res = await fetch("/api/check", { method: "POST", body: form });
          const body = await res.json().catch(() => null);
          if (!res.ok || !body) update(row.index, { status: "error", error: body?.error ?? `HTTP ${res.status}` });
          else update(row.index, { status: "done", result: body.result, extraction: body.extraction, bands: body.bands ?? {}, ms: body.ms, checkedAt: new Date() });
        } catch {
          update(row.index, { status: "error", error: "Network problem — run again to retry this row." });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    setWallMs(Math.round(performance.now() - startedAt.current));
    setRunning(false);
    setExportedSince(false);
    setVisited(new Set());
  }

  // No post-run band sweep and no lazy panel fetch any more: bands arrive
  // with each row's verdict from the check call itself, the same way the
  // single page gets them. The only band repair left is the client-side OCR
  // pass in the gate effect below, also shared with the single page.

  const setBoldReview = (index: number, v: "confirmed" | "flagged" | undefined) =>
    setRows((rs) => rs.map((r) => (r.index === index ? { ...r, boldReview: v } : r)));

  // Swap a row's preview to the PREPARED (deskewed/downscaled) image — the
  // geometry every located band and bold measurement lives in. Overlays drawn
  // on the original tilted upload landed in the wrong place (user-reported).
  // Guarded by a ref so the several call sites (check, locate, detail) swap
  // at most once per row; the old blob URL is revoked after the re-render.
  const preparedIdx = useRef<Set<number>>(new Set());
  const swapPreparedUrl = (index: number, small: File, original?: File) => {
    if (small === original || preparedIdx.current.has(index)) return;
    preparedIdx.current.add(index);
    const url = URL.createObjectURL(small);
    setRows((rs) =>
      rs.map((r) => {
        if (r.index !== index) return r;
        const old = r.imageUrl;
        if (old) window.setTimeout(() => URL.revokeObjectURL(old), 3000);
        return { ...r, imageUrl: url, prepared: true };
      }),
    );
  };

  // Per-field ruling from the detail panel's comparison rows. Toggling off
  // removes the key so "no decision" and "decided" never blur together.
  const setFieldDecision = (index: number, field: string, d: FieldDecision | null) =>
    setRows((rs) =>
      rs.map((r) => {
        if (r.index !== index) return r;
        const next = { ...r.fieldReview };
        if (d) next[field] = d;
        else delete next[field];
        return { ...r, fieldReview: next };
      }),
    );

  // Decided cards leave the attention-only strip immediately, so a misclick
  // needs a way back: every decision offers a transient Undo that restores
  // the previous state (and returns the card to the strip).
  const [boldUndo, setBoldUndo] = useState<{ index: number; prev?: "confirmed" | "flagged"; next?: "confirmed" | "flagged"; filename: string } | null>(null);
  const boldUndoTimer = useRef<number | null>(null);
  const markBold = (index: number, v: "confirmed" | "flagged" | undefined) => {
    const row = rows.find((r) => r.index === index);
    setBoldUndo({ index, prev: row?.boldReview, next: v, filename: row?.filename ?? "" });
    if (boldUndoTimer.current) window.clearTimeout(boldUndoTimer.current);
    boldUndoTimer.current = window.setTimeout(() => setBoldUndo(null), 8000);
    setBoldReview(index, v);
  };

  // Multi-signal gate: whenever an eligible row has its warning band and no
  // machine result yet, measure and gate it (worst case 1.9% silent misses —
  // see lib/compare/boldGate.ts and rubric C9). Claim-on-start dedupe; the
  // OCR worker serializes internally.
  const gateRunning = useRef<Set<number>>(new Set());
  const bandFixing = useRef<Set<number>>(new Set());
  useEffect(() => {
    // PDFs and rows with no image can never be measured — straight to "human"
    // so the attention-only strip can show them. A missing warning band is NOT
    // in that set any more: it gets one OCR attempt first (below), because the
    // locator missing the warning is a locator problem, not an unreadable
    // label, and it used to cost a human glance every time.
    const unmeasurable = rows.filter(
      (r) => boldEligible(r) && r.boldAuto === undefined && (r.file?.type === "application/pdf" || !r.imageUrl),
    );
    if (unmeasurable.length) {
      const idx = new Set(unmeasurable.map((r) => r.index));
      setRows((rs) => rs.map((r) => (idx.has(r.index) ? { ...r, boldAuto: "human" } : r)));
    }

    // Locator returned no warning band: read the image for it once. Marked
    // via bandFixed so a genuine miss settles to "human" instead of looping.
    const needBand = rows.filter(
      (r) =>
        boldEligible(r) && r.boldAuto === undefined && r.imageUrl && r.file?.type !== "application/pdf" &&
        r.bands !== undefined && !r.bands.warning && !r.bandFixed && !bandFixing.current.has(r.index),
    );
    const bandGen = batchGen.current;
    for (const t of needBand) {
      bandFixing.current.add(t.index);
      void (async () => {
        const found = await ocrWarningBand(t.imageUrl!);
        if (bandGen !== batchGen.current) return;
        setRows((rs) =>
          rs.map((r) =>
            r.index === t.index
              ? found
                ? { ...r, bands: { ...r.bands, warning: found }, bandFixed: true }
                : { ...r, bandFixed: true, boldAuto: "human" as BoldGateResult }
              : r,
          ),
        );
        bandFixing.current.delete(t.index);
      })();
    }
    const targets = rows.filter(
      (r) =>
        boldEligible(r) && r.boldAuto === undefined && r.bands?.warning && r.imageUrl &&
        r.file && r.file.type !== "application/pdf" && !gateRunning.current.has(r.index),
    );
    const gen = batchGen.current;
    for (const t of targets) {
      gateRunning.current.add(t.index);
      void (async () => {
        try {
          let band = t.bands!.warning!;
          let signals = await measureBoldSignals(t.imageUrl!, band);
          // Null means the crop held no GOVERNMENT prefix + body word — most
          // often a band pointing at the wrong part of the label. Read the
          // image for the real one and try again before spending a human's
          // attention, and keep the corrected band so the strip's magnifier
          // shows the warning rather than whatever the locator picked.
          if (!signals && !t.bandFixed) {
            const found = await ocrWarningBand(t.imageUrl!);
            if (gen !== batchGen.current) return;
            if (found && (found[0] !== band[0] || found[1] !== band[1])) {
              band = found;
              signals = await measureBoldSignals(t.imageUrl!, band);
            }
            const corrected = found;
            setRows((rs) =>
              rs.map((r) => {
                if (r.index !== t.index) return r;
                const bands = { ...r.bands };
                // Measurement found no warning in the located band, and reading
                // the image found no warning either: we do not know where it
                // is. DROP the band rather than keep it. Keeping it produced
                // the worst available state — a confident zoom into an
                // arbitrary strip of the label, and a "show on label"
                // highlight over the wrong section, while asking a human to
                // judge bold from it. An honest "couldn't locate it, open the
                // row" is worth more than a precise-looking wrong answer.
                if (corrected) bands.warning = corrected;
                else delete bands.warning;
                return { ...r, bandFixed: true, bands };
              }),
            );
          }
          const verdict = applyBoldGate(signals, t.result!.warning.boldAdvisory);
          if (gen !== batchGen.current) return; // stale: a new batch reused these indexes
          setRows((rs) => rs.map((r) => (r.index === t.index ? { ...r, boldAuto: verdict } : r)));
        } catch {
          if (gen !== batchGen.current) return;
          setRows((rs) => rs.map((r) => (r.index === t.index ? { ...r, boldAuto: "human" } : r)));
        } finally {
          gateRunning.current.delete(t.index);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const rulingBar = (r: BatchRow) => (
    <RulingBar row={r}
      onReview={(v) => setRows((rs) => rs.map((x) => (x.index === r.index ? { ...x, agentReview: v } : x)))}
      onMarkBold={markBold}
      onClearFields={() => setRows((rs) => rs.map((x) => (x.index === r.index ? { ...x, fieldReview: undefined } : x)))}
    />
  );

  /** The evidence panel, rendered identically in the docked and inline
   *  variants. Every decision control sits exactly where the single-check page
   *  puts it: flagged fields decide on their own comparison rows, and the bold
   *  glance decides on the government-warning Formatting row. */
  const panelResult = (r: BatchRow) => (
    <ResultView
      result={r.result!}
      extraction={r.extraction!}
      imageUrl={r.imageUrl!}
      bands={r.bands ?? {}}
      /* Bands arrive with the verdict (same call as a single check), so a
         done row always has them; {} = the locator ran and found nothing,
         which is the only state that justifies the fallback caption. */
      bandsPending={r.bands === undefined}
      ms={r.ms}
      boldAuto={r.boldAuto ?? null}
      boldHuman={r.boldReview ?? null}
      boldMeasuring={boldEligible(r) && r.boldAuto === undefined}
      onBoldReview={(d) => markBold(r.index, d ?? undefined)}
      fieldReview={r.fieldReview}
      onFieldReview={(field, d) => setFieldDecision(r.index, field, d)}
      isPdf={r.filename.toLowerCase().endsWith(".pdf")}
      compact
    />
  );

  function exportCsv() {
    const header = ["filename", "overall", "agent_review", "government_warning", "bold_check", "brand_name", "class_type", "alcohol_content", "net_contents", "notes"];
    const safe = (s: string) => (/^[=+\-@]/.test(s) ? `'${s}` : s);
    const lines = [...rows].sort((a, b) => a.index - b.index).map((r) => {
      if (!r.result) return [safe(r.filename), r.status, "", "", "", "", "", "", "", r.error ? safe(`ERROR: ${r.error}`) : ""];
      // Per-field cells carry the agent's ruling alongside the machine
      // verdict — the export is the audit record, so both survive.
      const f = (n: string) => {
        const v = r.result!.fields.find((x) => x.field === n)?.verdict ?? "";
        const d = r.fieldReview?.[n];
        return d ? `${v} (${d === "accepted" ? "accepted by agent" : "rejected by agent"})` : v;
      };
      // The bold record: a human decision wins; otherwise the machine gate's
      // result; otherwise unconfirmed. Only for labels whose text passed.
      // One vocabulary, who-did-it explicit: agent_* is a human decision,
      // auto_* is the measurement gate. The raw state names used to leak
      // through for the human half ("confirmed"/"flagged" next to
      // "auto_verified"), which made one column speak two languages.
      const bold = boldEligible(r)
        ? r.boldReview === "confirmed" ? "agent_verified"
          : r.boldReview === "flagged" ? "agent_flagged"
          : r.boldAuto === "bold" ? "auto_verified" : r.boldAuto === "not_bold" ? "auto_flagged" : "unconfirmed"
        : "";
      return [
        safe(r.filename), r.result.overall, r.agentReview ?? "", r.result.warning.verdict, bold,
        f("brand_name"), f("class_type"), f("alcohol_content"), f("net_contents"),
        safe([...r.result.warning.notes, ...r.result.fields.map((x) => x.note).filter(Boolean)].join(" | ")),
      ];
    });
    const blob = new Blob([toCsv([header, ...lines])], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "labelcheck-batch-results.csv";
    a.click();
    URL.revokeObjectURL(a.href);
    setSavedToast(true);
    setExportedSince(true);
    setTimeout(() => setSavedToast(false), 4000);
  }

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { matched: 0, review: 0, bold_checking: 0, not_required: 0, error: 0, pending: 0 };
    for (const r of rows) c[bucketOf(r)]++;
    return c;
  }, [rows]);
  const done = rows.length - counts.pending;
  const boldRows = useMemo(() => rows.filter(boldEligible), [rows]);
  // Machine-verified rows are resolved; machine-flagged and inconclusive
  // rows still need eyes — those are the only ones the strip shows.
  const boldPendingRows = useMemo(() => boldRows.filter(boldPendingRow), [boldRows]);
  // The chip counts the SAME rows the strip shows — counting not-yet-measured
  // rows here made the chip promise more cards than the strip contained while
  // the gate was still working.
  const boldPending = boldPendingRows.length;
  const boldMeasuring = boldRows.some((r) => !r.boldReview && r.boldAuto === undefined);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      const b = bucketOf(r);
      if (filter !== "all" && !(filter === b || (filter === "review" && b === "error"))) return false;
      if (q && !r.filename.toLowerCase().includes(q) && !(r.application.brand_name ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
    if (!running && rows.every((r) => r.status !== "queued" && r.status !== "checking")) {
      const rank: Record<Bucket, number> = { error: 0, review: 1, bold_checking: 2, matched: 3, not_required: 4, pending: 5 };
      return [...filtered].sort((a, b) => rank[bucketOf(a)] - rank[bucketOf(b)] || a.index - b.index);
    }
    return filtered;
  }, [rows, filter, search, running]);
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageRows = visible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const detail = rows.find((r) => r.index === openRow);
  const order = visible.map((r) => r.index);
  const orderPos = openRow !== null ? order.indexOf(openRow) : -1;

  // Keyboard: ↑↓ move selection through filtered rows, Enter opens, Esc
  // closes. Ignored while an input is focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (!rows.length) return;
      if (e.key === "Escape") { setOpenRow(null); return; }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
      // Never swallow Enter on a focused control — that is its activation
      // key, and stealing it broke every button and nav link on this page.
      if (e.key === "Enter" && t.closest('button, a, [role="button"], select')) return;
      e.preventDefault();
      if (e.key === "Enter") {
        const target = selectedRow ?? order[0];
        if (target !== undefined) { setOpenRow(target); setTab("overview"); }
        return;
      }
      // Arrows move the SELECTION; they only move the open panel along with
      // it when a panel is already open ("↑↓ to move · Enter to open").
      const dir = e.key === "ArrowDown" ? 1 : -1;
      const currentIdx = selectedRow !== null ? order.indexOf(selectedRow) : openRow !== null ? orderPos : -1;
      const nxt = order[Math.min(Math.max(currentIdx + dir, 0), order.length - 1)];
      if (nxt !== undefined) {
        setSelectedRow(nxt);
        setPage(Math.floor(order.indexOf(nxt) / PAGE_SIZE));
        if (openRow !== null) { setOpenRow(nxt); setTab("overview"); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows.length, order, orderPos, openRow, selectedRow]);

  const atLast = orderPos === order.length - 1;
  const stepPanel = (dir: 1 | -1) => {
    if (!order.length) return;
    const at = orderPos >= 0 ? orderPos : 0;
    // The loop has a finish line: forward from the last row closes the panel
    // (goal gradient needs a terminus — two audits flagged the endless wrap).
    if (dir === 1 && at === order.length - 1) { setOpenRow(null); return; }
    const nxt = order[Math.min(Math.max(at + dir, 0), order.length - 1)];
    setOpenRow(nxt);
    setTab("overview");
    setPage(Math.floor(order.indexOf(nxt) / PAGE_SIZE));
  };

  // "Seen" state: rows the panel has visited get a subtle tick, so an
  // interrupted reviewer knows where they stopped.
  useEffect(() => {
    if (openRow !== null) setVisited((v) => (v.has(openRow) ? v : new Set(v).add(openRow)));
  }, [openRow]);

  // Bring the inline panel into view when it opens off-screen (it renders
  // below the table under xl — including at browser zoom levels that put a
  // wide monitor under 1280 CSS px).
  useEffect(() => {
    if (openRow === null) return;
    // Wait out the re-render that unmounts the bold strip above the table —
    // measuring before it collapses gives a stale position — then scroll the
    // window itself. scrollIntoView on this element proved unreliable: opening
    // a row from the strip at 1200px left the panel at y≈862 in an 800px
    // viewport with the page still at scrollY 0, so the click read as a no-op.
    const id = window.setTimeout(() => {
      const el = inlinePanelRef.current;
      if (!el || el.offsetParent === null) return; // docked variant is showing
      const box = el.getBoundingClientRect();
      if (box.top < 0 || box.top > window.innerHeight * 0.5) {
        window.scrollTo({ top: Math.max(0, window.scrollY + box.top - 12), behavior: "smooth" });
      }
    }, 140);
    return () => window.clearTimeout(id);
  }, [openRow]);

  const statusDot = (r: BatchRow, size = 22) => {
    const b = bucketOf(r);
    // A bold type the agent REJECTED is a regulatory failure, not review work
    // — the row reads red, the same as the panel's banner now does, and it is
    // named as a warning failure rather than as a field "Mismatch".
    const fieldFail = r.result?.fields.some((f) => f.verdict === "possible_mismatch" && r.fieldReview?.[f.field] !== "accepted");
    const warnFail = r.result?.overall === "warning_failure" || r.boldReview === "flagged";
    const isFail = warnFail || fieldFail || r.result?.overall === "not_a_label";
    // A green tick must mean FINISHED. While a bold glance is still owed,
    // the row reads amber "!" even though it sits in the Matched bucket.
    const boldOwed = boldPendingRow(r);
    // A label the agent rejected reads red, matching its own pill and the
    // panel it was rejected in — it is a finding now, not a queue item.
    const cls =
      b === "error" || r.agentReview === "correction" || (isFail && r.agentReview !== "ok") ? "bg-red"
        : b === "review" || boldOwed ? "bg-amber"
        : b === "matched" ? "bg-green" : "bg-na";
    const labels: Record<Bucket, string> = {
      matched: "Matched", review: "Needs review", bold_checking: "Checking bold type…", error: "Error", not_required: "Not required", pending: "Waiting",
    };
    const label =
      r.agentReview === "ok" ? "Accepted by you" : r.agentReview === "correction" ? "Rejected by you"
        : b === "review" && fieldFail ? "Mismatch — needs review"
        : b === "review" && warnFail ? "Government warning fails"
        : boldOwed ? "Bold type still needs a look" : labels[b];
    const glyph =
      b === "error" || r.agentReview === "correction" || (isFail && r.agentReview !== "ok") ? "✕"
        : b === "review" || boldOwed ? "!"
        : b === "bold_checking" ? "…"
        : b === "matched" ? "✓" : "–";
    return (
      <span
        title={label}
        style={{ width: size, height: size }}
        className={`flex shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${cls}`}
      >
        {glyph}
        <span className="sr-only">{label}</span>
      </span>
    );
  };

  const statusPill = (r: BatchRow) => {
    const b = bucketOf(r);
    const fieldFail = r.result?.fields.some((f) => f.verdict === "possible_mismatch" && r.fieldReview?.[f.field] !== "accepted");
    const warnFail = r.result?.overall === "warning_failure" || r.boldReview === "flagged";
    const isFail = warnFail || fieldFail || r.result?.overall === "not_a_label";
    const boldOwed = boldPendingRow(r);
    const label =
      r.agentReview === "ok" ? "Accepted ✓" : r.agentReview === "correction" ? "Rejected"
        : b === "error" ? "Error" : b === "review" ? (fieldFail ? "Mismatch" : warnFail ? "Warning fails" : "Needs review")
        : boldOwed ? "Bold to confirm"
        : b === "bold_checking" ? "Checking bold…"
        : b === "matched" ? "Matched" : b === "not_required" ? "Not required" : "Waiting";
    const cls =
      r.agentReview === "ok" ? "bg-green-tint text-green" : r.agentReview === "correction" ? "bg-red-tint text-red"
        : b === "error" || isFail ? "bg-red-tint text-red" : b === "review" || boldOwed ? "bg-amber-tint text-amber"
        : b === "matched" ? "bg-green-tint text-green" : "bg-na-tint text-muted";
    return <span className={`shrink-0 whitespace-nowrap rounded-[5px] px-2 py-0.5 text-[11.5px] font-bold ${cls}`}>{label}</span>;
  };

  const chip = (key: "all" | Bucket, label: string, n: number, tone: string) => {
    const active = filter === key;
    return (
      <button
        key={key}
        onClick={() => { setFilter(key); setPage(0); }}
        className={`flex h-8 items-center gap-1.5 rounded-[7px] border px-3 text-[12.5px] font-semibold transition ${
          active ? `${tone === "green" ? "border-green bg-green-tint text-green" : tone === "amber" ? "border-amber bg-amber-tint text-amber" : tone === "na" ? "border-na bg-na-tint text-muted" : "border-navy bg-select text-navy"}` : "border-line bg-card text-ink-2 hover:bg-line-soft"
        }`}
      >
        {label}
        <span className={`font-bold ${tone === "green" ? "text-green" : tone === "amber" ? "text-amber" : tone === "na" ? "text-muted-2" : "text-navy"}`}>{n}</span>
      </button>
    );
  };

  const topBar = (
    <>
      {/* The page name already appears in the sidebar nav (desktop) and the
          header mini-nav (mobile) — the top-bar title earns its place only
          while the sidebar is collapsed to icons (detail panel open). */}
      {detail && <span className="hidden text-[15px] font-bold text-ink md:inline">Batch review</span>}
      {rows.length > 0 && (
        <span className={`rounded-[5px] px-2 py-0.5 text-[11.5px] font-bold ${running ? "bg-select text-navy" : done === rows.length && done > 0 ? "bg-green-tint text-green" : "bg-line-soft text-muted"}`}>
          {running ? `${done}/${rows.length}` : done === rows.length && done > 0 ? "Complete" : "Ready"}
        </span>
      )}
      {/* Empty batch page: both actions are dead (nothing to export, no batch
          to clear) and rendered at 40% opacity they read as missing rather
          than disabled. Show them once they can actually do something. */}
      {rows.length > 0 && (
      <span className="ml-auto flex items-center gap-2">
        <button
          onClick={exportCsv}
          disabled={done === 0}
          className="flex h-9 items-center gap-1.5 rounded-[7px] border border-line-input bg-card px-3 text-[13px] font-semibold text-ink-2 hover:bg-line-soft disabled:opacity-50"
        >
          ↓ Download report (CSV)
        </button>
        <button
          onClick={() => {
            // The one truly irreversible act in the app — nothing is stored.
            if (done > 0 && !exportedSince) {
              if (!window.confirm(`This clears all ${rows.length} results and nothing is stored. Download the report first?`)) return;
            }
            resetBatchState();
            // Free the blobs before dropping the rows — clearing first would
            // strand one object URL per label for the life of the tab.
            setRows((old) => {
              for (const r of old) if (r.imageUrl) URL.revokeObjectURL(r.imageUrl);
              return [];
            });
            setPairingIssues([]); setWallMs(null); setOpenRow(null); setVisited(new Set());
          }}
          disabled={running || rows.length === 0}
          className="h-9 rounded-[7px] bg-navy px-3 text-[13px] font-bold text-white hover:bg-navy-hover disabled:opacity-40"
        >
          + New batch
        </button>
      </span>
      )}
    </>
  );

  return (
    <Shell topBar={topBar} collapsed={detail !== undefined && detail !== null}>
      {savedToast && (
        <div className="no-print fixed bottom-6 right-6 z-50 rounded-[10px] border border-ok-line bg-green-tint px-4 py-3 text-[13.5px] font-semibold text-green shadow-lg" role="status">
          Report saved to your Downloads folder.
        </div>
      )}
      {boldUndo && (
        <div className="no-print fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-[10px] border border-line bg-card px-4 py-3 text-[13px] shadow-lg" role="status">
          <span className="max-w-[320px] truncate text-ink">
            <b>{boldUndo.filename}</b>
            {boldUndo.next === "confirmed" ? " — bold confirmed" : boldUndo.next === "flagged" ? " — flagged as not bold" : " — decision cleared"}
          </span>
          <button
            onClick={() => { setBoldReview(boldUndo.index, boldUndo.prev); setBoldUndo(null); }}
            className="whitespace-nowrap rounded-[7px] border border-line-input px-3 py-1 text-[12.5px] font-bold text-navy hover:bg-select"
          >
            Undo
          </button>
        </div>
      )}

      {rows.length === 0 ? (
        /* Empty state (design §5) */
        <div className="mx-auto mt-10 flex w-full max-w-[640px] flex-col items-center gap-4">
          <div
            role="button"
            tabIndex={0}
            aria-label="Choose or drop the CSV and label files"
            onClick={() => filesInput.current?.click()}
            onKeyDown={(e) => e.key === "Enter" && filesInput.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); onFiles(Array.from(e.dataTransfer.files)); }}
            className={`flex w-full cursor-pointer flex-col items-center gap-2 rounded-[14px] border-[1.5px] border-dashed px-8 py-12 text-center transition ${dragOver ? "border-navy bg-select" : "border-[#dfe3e8] bg-card"}`}
          >
            <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" className="text-muted-2" aria-hidden>
              <path d="M7 18a4.6 4.6 0 0 1-.9-9.1 6 6 0 0 1 11.7 1.6A4 4 0 0 1 17 18h-1M12 12v8m0-8l-3 3m3-3l3 3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="text-[16px] font-bold text-ink">Start a batch review</span>
            <span className="max-w-md text-[13px] text-muted">
              Drop the application spreadsheet (CSV — one row per label, matched by file name) together with the label files.
            </span>
            <span className="mt-1 flex h-[38px] items-center rounded-[7px] border border-line-input bg-card px-4 text-[13px] font-semibold text-ink">
              Choose files
            </span>
            <span className="text-[12px] text-muted-2">PDF, PNG, JPG — images up to 8 MB, PDFs up to 10 MB each</span>
          </div>
          <p className="text-[13px] text-muted">
            Just exploring?{" "}
            <button onClick={loadSampleBatch} className="font-semibold text-navy hover:underline">Load the sample batch</button>
            <span className="text-muted-2"> · </span>
            {/* The two downloads are labelled with what they CONTAIN. "sample
                CSV" alone read as "the sample", so people downloaded it, dropped
                it straight back in, and got an error per row — the spreadsheet
                names the labels, it does not carry them. */}
            <a href="/api/batch-samples/sample-batch.zip" download className="font-semibold text-navy hover:underline">sample bundle (zip — spreadsheet + labels)</a>
            <span className="text-muted-2"> · </span>
            <a href="/api/batch-samples/batch.csv" download className="font-semibold text-navy hover:underline">spreadsheet only</a>
          </p>
          {globalError && (
            <div className="w-full rounded-[10px] border border-bad-line bg-red-tint p-4 text-[13.5px] font-semibold text-red">{globalError}</div>
          )}
          <input
            ref={filesInput} type="file" multiple className="hidden"
            accept=".csv,text/csv,image/png,image/jpeg,image/webp,application/pdf"
            onChange={(e) => onFiles(Array.from(e.target.files ?? []))}
          />
        </div>
      ) : (
        <div className={`flex items-start gap-0 ${detail ? "" : ""}`}>
          <div className="min-w-0 flex-1">
            {/* HOW IT WORKS legend (design: wrapping grid, not flex+separators) */}
            {!detail && (
              <div className="mb-4 grid gap-4 rounded-[10px] border border-line bg-card px-[18px] py-3.5 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
                {[
                  ["Upload labels", "PDF or images, listed in the CSV."],
                  ["Auto check", "Each label vs its application row."],
                  ["Review exceptions", "Only what needs attention."],
                ].map(([t, d], i) => (
                  <span key={t} className="flex items-start gap-2.5">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-navy text-[11px] font-bold text-white" aria-hidden>{i + 1}</span>
                    <span className="text-[12.5px] leading-snug text-muted"><span className="font-bold text-ink">{t}</span> — {d}</span>
                  </span>
                ))}
              </div>
            )}

            {/* Same checking card as the single-check page (shared component),
                in its batch variant — cohesion without hiding the table: rows
                keep streaming in below while it runs. */}
            {running && !detail && (
              <div className="mb-4">
                <CheckingCard
                  imageUrl={(rows.find((r) => r.status === "checking") ?? rows.find((r) => r.imageUrl))?.imageUrl ?? null}
                  isPdf={(rows.find((r) => r.status === "checking"))?.file?.type === "application/pdf"}
                  batch={{
                    done,
                    total: rows.length,
                    etaLabel: (() => {
                      const doneRows = rows.filter((r) => r.ms);
                      if (!doneRows.length) return undefined;
                      const avg = doneRows.reduce((a, r) => a + r.ms!, 0) / doneRows.length;
                      const etaS = Math.ceil(((rows.length - done) * avg) / CONCURRENCY / 1000);
                      return `About ${etaS >= 60 ? `${Math.ceil(etaS / 60)} min` : `${etaS}s`} left`;
                    })(),
                  }}
                />
              </div>
            )}
            {globalError && (
              <div className="mb-4 rounded-[10px] border border-bad-line bg-red-tint p-4 text-[13.5px] font-semibold text-red">{globalError}</div>
            )}
            {pairingIssues.length > 0 && (
              <div className="mb-4 rounded-[10px] border border-warn-line bg-amber-tint p-4 text-[13px] text-amber">
                <p className="font-bold">Pairing issues — fix these before trusting results:</p>
                <ul className="mt-1 list-inside list-disc">{pairingIssues.map((p, i) => <li key={i}>{p}</li>)}</ul>
              </div>
            )}

            {/* Bold spot-check strip — attention-only: it appears by itself
                when labels need a human glance (the measurement gate resolves
                the rest silently) and disappears when nothing does. Only the
                rows that need eyes are shown. */}
            {!detail && !stripDismissed && boldPendingRows.length > 0 && (
              <div className="mb-4 rounded-xl border border-line bg-card">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-soft px-4 py-3">
                  <p className="text-[13.5px] font-bold text-ink">Confirm bold type</p>
                  <p className="text-[12px] text-muted">
                    {boldMeasuring
                      ? "Measuring bold type across the batch — the ones below already need your eyes. Hover a warning to magnify it, then Accept (bold) or Reject (not bold)."
                      : boldRows.length - boldPendingRows.length > 0
                        ? `${boldRows.length - boldPendingRows.length} of ${boldRows.length} verified by measurement — these ${boldPendingRows.length === 1 ? "is the one" : `are the ${boldPendingRows.length}`} that need your eyes. Hover a warning to magnify it, then Accept (bold) or Reject (not bold).`
                        : "Bold is the one check that needs your eyes. Hover a warning below to magnify it, then Accept the ones that look bold and Reject any that don't."}
                  </p>
                  <span className="ml-auto whitespace-nowrap rounded-[5px] bg-amber-tint px-2 py-0.5 text-[11.5px] font-bold text-amber">
                    {boldPendingRows.length} left
                  </span>
                  <button onClick={() => setStripDismissed(true)} aria-label="Hide bold confirmation" className="flex h-7 w-7 items-center justify-center rounded-[6px] text-ink-2 hover:bg-line-soft">✕</button>
                </div>
                {/* auto-FIT, not auto-fill: with three cards left the empty
                    tracks used to hold their width and every crop stayed
                    narrow. Collapsing them lets the remaining cards grow, and
                    a bigger card is the cheapest legibility there is — capped
                    at 340px so the last card left doesn't stretch across the
                    whole strip. */}
                <div className="grid gap-3 p-4 [grid-template-columns:repeat(auto-fit,minmax(260px,340px))]">
                  {boldPendingRows.map((r) => (
                    <BoldCard
                      key={r.index}
                      row={r}
                      onMark={markBold}
                      onOpen={(i) => { setSelectedRow(i); setOpenRow(i); setTab("overview"); }}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Table card */}
            <div className="rounded-xl border border-line bg-card">
              <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-3">
                {chip("all", "All", rows.length, "navy")}
                {chip("matched", "Matched", counts.matched, "green")}
                {chip("review", "Need review", counts.review + counts.error, "amber")}
                {/* Temporary by construction: this chip exists only while the
                    always-on bold pass is still measuring otherwise-clean
                    rows, and disappears with its last row. Need review never
                    inflates with rows nobody has flagged. */}
                {counts.bold_checking > 0 && chip("bold_checking", "Checking bold", counts.bold_checking, "na")}
                {chip("not_required", "Not required", counts.not_required, "na")}
                {boldPending > 0 && (
                  <button
                    onClick={() => setStripDismissed((s) => !s)}
                    title="Bold checks that still need a human glance — the measurement gate resolved the rest"
                    className={`${CTRL_BASE} ${!stripDismissed ? CTRL_ON.amber : CTRL_IDLE}`}
                  >
                    Confirm bold
                    <span className="font-bold text-amber">{boldPending}</span>
                  </button>
                )}
                <span className="ml-auto flex items-center gap-3">
                  {rows.some((r) => r.status === "queued" || (r.status === "error" && r.file)) && (
                    <button
                      onClick={run}
                      disabled={running}
                      className="h-9 rounded-[7px] bg-navy px-4 text-[13px] font-bold text-white hover:bg-navy-hover disabled:opacity-60"
                    >
                      {running ? `Checking… ${done}/${rows.length}` : "Check all labels"}
                    </button>
                  )}
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                    placeholder="Search file name or brand…"
                    aria-label="Search results"
                    className="h-9 w-60 rounded-[7px] border border-line-input bg-card px-3 text-[13px] placeholder:text-muted-2 focus:border-navy focus:outline-none"
                  />
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="border-b border-line-soft text-[11px] font-bold uppercase tracking-[0.06em] text-muted">
                    <tr>
                      <th className="w-[52px] px-4 py-2.5">Status</th>
                      <th className="px-2 py-2.5">File name</th>
                      {!detail && <th className="hidden px-2 py-2.5 lg:table-cell">Brand</th>}
                      {!detail && <th className="hidden whitespace-nowrap px-2 py-2.5 lg:table-cell">Checked</th>}
                      {!detail && <th className="hidden whitespace-nowrap px-2 py-2.5 lg:table-cell">Result summary</th>}
                      <th className="w-7 px-2 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((r) => {
                      const selected = openRow === r.index;
                      return (
                        <tr
                          key={r.index}
                          onClick={() => {
                            if (!r.result) return;
                            setSelectedRow(r.index);
                            if (selected) { setOpenRow(null); return; }
                            setOpenRow(r.index);
                            setTab("overview");
                          }}
                          className={`border-b border-line-row text-[12.5px] last:border-0 ${r.result ? "cursor-pointer" : ""} ${selected || selectedRow === r.index ? "bg-select shadow-[inset_3px_0_0_#10233f]" : "hover:bg-[#fafbfc]"}`}
                        >
                          <td className="px-4 py-2.5">{statusDot(r)}</td>
                          <td className="px-2 py-2.5">
                            <span className="flex items-center gap-2.5">
                              {r.imageUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={r.imageUrl} alt="" className="h-10 w-[30px] shrink-0 rounded-[3px] border border-paper-line object-cover" />
                              ) : (
                                <span className="h-10 w-[30px] shrink-0 rounded-[3px] border border-line bg-line-soft" />
                              )}
                              <span className="min-w-0">
                                <span className="block max-w-48 truncate text-[13px] font-bold text-ink">
                                  {r.filename}
                                  {visited.has(r.index) && openRow !== r.index && (
                                    <span className="ml-1.5 text-[11px] font-normal text-muted-2" title="Reviewed">✓ seen</span>
                                  )}
                                </span>
                                {r.file && (
                                  <span className="block text-[11.5px] text-muted-2">
                                    {r.file.type === "application/pdf" ? "PDF" : "IMG"} • {(r.file.size / 1024 / 1024).toFixed(1)} MB
                                  </span>
                                )}
                              </span>
                            </span>
                          </td>
                          {!detail && <td className="hidden max-w-40 truncate px-2 py-2.5 text-[12px] font-semibold text-ink lg:table-cell">{r.application.brand_name}</td>}
                          {!detail && (
                            <td className="hidden whitespace-nowrap px-2 py-2.5 text-[11.5px] text-muted-2 lg:table-cell">
                              {r.checkedAt ? <>{fmtTime(r.checkedAt)}<br />{(r.ms! / 1000).toFixed(1)}s</> : "—"}
                            </td>
                          )}
                          {!detail && <td className="hidden whitespace-nowrap px-2 py-2.5 text-muted lg:table-cell">{rowSummary(r)}</td>}
                          <td className="px-2 py-2.5 text-muted-2">
                            {r.result && (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {pageRows.length === 0 && (
                      <tr><td colSpan={detail ? 3 : 6} className="px-4 py-6 text-center text-[13px] text-muted-2">Nothing matches this filter.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-soft px-4 py-2.5 text-[12px] text-muted-2">
                <span>Showing {visible.length === 0 ? 0 : page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, visible.length)} of {visible.length} labels · ↑↓ to move · Enter to open · Esc to close</span>
                {pages > 1 && (
                  <span className="flex items-center gap-1">
                    <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} aria-label="Previous page" className="h-7 w-7 rounded-[6px] border border-line bg-card hover:bg-line-soft disabled:opacity-40">‹</button>
                    {Array.from({ length: pages }, (_, i) => (
                      <button key={i} onClick={() => setPage(i)} className={`h-7 w-7 rounded-[6px] text-[12px] font-semibold ${i === page ? "bg-navy text-white" : "border border-line bg-card text-ink-2 hover:bg-line-soft"}`}>{i + 1}</button>
                    ))}
                    <button onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page === pages - 1} aria-label="Next page" className="h-7 w-7 rounded-[6px] border border-line bg-card hover:bg-line-soft disabled:opacity-40">›</button>
                  </span>
                )}
              </div>
            </div>

            {wallMs !== null && !detail && (
              <p className="mt-2 text-[12px] text-muted-2">Processed on {fmtTime(new Date())} · checked in {(wallMs / 1000).toFixed(1)}s</p>
            )}

            {/* Info strip (design's three-column footer, refilled with
                operational facts — two audits flagged the brochure voice). */}
            {!detail && (
              <div className="mt-5 grid gap-8 rounded-xl bg-[#f0f2f5] px-7 py-6 md:grid-cols-3">
                {[
                  { c: "bg-navy", t: "What it checks", d: <>Brand, class/type, alcohol content, net contents, and the exact government warning — each label against its own application row.</> },
                  { c: "bg-green-dark", t: "How it decides", d: <>Fixed rules in the software make every pass or fail; the computer only reads the label. <b>Type size and physical checks stay manual.</b></> },
                  { c: "bg-amber", t: "Working faster", d: <>Problems sort to the top when the run finishes. <b>Keyboard: ↑↓ move · Enter open · Esc close.</b></> },
                ].map((l) => (
                  <span key={l.t} className="flex items-start gap-3.5">
                    <span className={`h-10 w-10 shrink-0 rounded-full ${l.c}`} aria-hidden />
                    <span className="text-[12.5px] leading-snug text-muted"><span className="block text-[13.5px] font-bold text-ink">{l.t}</span>{l.d}</span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Docked detail panel (design §6): sticky sibling column on xl+,
              full-width inline section below xl — a row click must never be
              a dead end that only removes information (behavioral F1;
              Windows 125% scaling puts many gov laptops under 1280px). */}
          {detail?.result && detail.extraction && detail.imageUrl && (() => {
            const panelInner = (
              <>
                <div className="flex items-center gap-2.5 px-6 py-[18px]">
                  <p className="min-w-0 flex-1 truncate text-[15px] font-bold text-ink">{detail.filename}</p>
                  {statusPill(detail)}
                  <button onClick={() => window.print()} aria-label="Print this result" title="Print this result" className="flex h-8 w-8 items-center justify-center rounded-[6px] border border-line text-ink-2 hover:bg-line-soft">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </button>
                  <button onClick={() => setOpenRow(null)} aria-label="Close panel" className="flex h-8 w-8 items-center justify-center rounded-[6px] text-ink-2 hover:bg-line-soft">✕</button>
                </div>
                <div className="flex gap-5 border-b border-line px-6">
                  {(["overview", "audit"] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTab(t)}
                      className={`pb-2 text-[13px] ${tab === t ? "border-b-2 border-navy font-bold text-ink" : "text-muted hover:text-ink-2"}`}
                    >
                      {t === "overview" ? "Overview" : "Audit trail"}
                    </button>
                  ))}
                </div>
                <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
                  {/* Both are mounted and toggled with CSS rather than swapped, so a
                      printed copy carries the evidence AND the trail whichever tab
                      is on screen. Printing used to lose the trail from Overview
                      and lose the evidence from Audit trail. */}
                  <div className={tab === "overview" ? "" : "hidden print:block"}>{panelResult(detail)}</div>
                  <div className={tab === "audit" ? "" : "hidden print:block print:mt-6"}><AuditTrail filename={detail.filename} fileSizeBytes={detail.file?.size} prepared={!!detail.prepared} isPdf={detail.file?.type === "application/pdf"} ms={detail.ms} checkedAt={detail.checkedAt} result={detail.result!} /></div>
                </div>
                {/* The ruling on the whole label closes the panel, after the
                    evidence — never above it competing with the per-row
                    controls for the same decision. */}
                <div className="flex flex-col gap-2.5 border-t border-line px-6 py-3">
                  {rulingBar(detail)}
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] text-muted-2">Label {orderPos + 1} of {order.length}</span>
                    <span className="flex items-center gap-2">
                      <span className="flex overflow-hidden rounded-[7px] border border-line-input">
                        <button onClick={() => stepPanel(-1)} aria-label="Previous label" className="flex h-[38px] w-[38px] items-center justify-center border-r border-line-input text-ink-2 hover:bg-line-soft">←</button>
                        <button onClick={() => stepPanel(1)} aria-label="Next label" className="flex h-[38px] w-[38px] items-center justify-center text-ink-2 hover:bg-line-soft">→</button>
                      </span>
                      <button onClick={() => stepPanel(1)} className="h-[38px] rounded-[7px] bg-navy px-4 text-[13px] font-bold text-white hover:bg-navy-hover">
                        {atLast ? "Done — back to list" : "Review next"}
                      </button>
                    </span>
                  </div>
                </div>
              </>
            );
            return (
              /* Pinned within the viewport: header, tabs, scrollable body AND
                 the Review-next footer all stay on screen (conformance #3). */
              /* Docks from lg (1024px), not xl. At xl the fallback caught every
                 1280-and-under window — including a 1200px browser and any
                 laptop at 125% scaling — and a panel appearing below the fold
                 reads as a click that did nothing. The sidebar collapses to
                 64px while this is open, so 1024px still leaves ~600px of
                 table beside a 360px panel. */
              <aside className="sticky top-3 ml-4 hidden h-[calc(100vh-24px)] w-[clamp(360px,32vw,480px)] flex-col overflow-hidden rounded-xl border border-line bg-card lg:flex">
                {panelInner}
              </aside>
            );
          })()}
        </div>
      )}

      {/* Below lg: the same panel renders inline under the table. Must match
          the docked variant's breakpoint exactly — while these disagreed, both
          rendered at 1024–1279px and the row opened twice. */}
      {rows.length > 0 && detail?.result && detail.extraction && detail.imageUrl && (
        <section ref={inlinePanelRef} className="mt-4 flex max-h-[80vh] flex-col rounded-xl border border-line bg-card lg:hidden">
          <div className="flex items-center gap-2.5 px-6 py-[18px]">
            <p className="min-w-0 flex-1 truncate text-[15px] font-bold text-ink">{detail.filename}</p>
            {statusPill(detail)}
            <button onClick={() => setOpenRow(null)} aria-label="Close panel" className="flex h-8 w-8 items-center justify-center rounded-[6px] text-ink-2 hover:bg-line-soft">✕</button>
          </div>
          <div className="flex gap-5 border-b border-line px-6">
            {(["overview", "audit"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`pb-2 text-[13px] ${tab === t ? "border-b-2 border-navy font-bold text-ink" : "text-muted hover:text-ink-2"}`}>
                {t === "overview" ? "Overview" : "Audit trail"}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
            {/* Both are mounted and toggled with CSS rather than swapped, so a
                      printed copy carries the evidence AND the trail whichever tab
                      is on screen. Printing used to lose the trail from Overview
                      and lose the evidence from Audit trail. */}
                  <div className={tab === "overview" ? "" : "hidden print:block"}>{panelResult(detail)}</div>
                  <div className={tab === "audit" ? "" : "hidden print:block print:mt-6"}><AuditTrail filename={detail.filename} fileSizeBytes={detail.file?.size} prepared={!!detail.prepared} isPdf={detail.file?.type === "application/pdf"} ms={detail.ms} checkedAt={detail.checkedAt} result={detail.result!} /></div>
          </div>
          <div className="flex flex-col gap-2.5 border-t border-line px-6 py-3">
            {rulingBar(detail)}
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-muted-2">Label {orderPos + 1} of {order.length}</span>
              <button onClick={() => stepPanel(1)} className="h-[38px] rounded-[7px] bg-navy px-4 text-[13px] font-bold text-white hover:bg-navy-hover">
                {atLast ? "Done — back to list" : "Review next"}
              </button>
            </div>
          </div>
        </section>
      )}
      {rows.length > 0 && (
        <input
          ref={filesInput} type="file" multiple className="hidden"
          accept=".csv,text/csv,image/png,image/jpeg,image/webp,application/pdf"
          onChange={(e) => onFiles(Array.from(e.target.files ?? []))}
        />
      )}
    </Shell>
  );
}

/** The agent's durable ruling on a ROW — outranks machine triage and exports
 *  as agent_review. It sits in the panel footer, after the evidence.
 *
 *  It used to sit above the evidence and carry its own pair of bold buttons,
 *  which meant one screen offered the bold decision in two places, in two
 *  vocabularies ("Looks bold / Not bold" up top, "Accept / Reject" on the
 *  warning row), while flagged fields decided on their own rows in a third
 *  spot. The bold decision now speaks one vocabulary everywhere it appears —
 *  Accept / Reject, on the government-warning Formatting row and on the
 *  Confirm-bold strip cards (both write the same state). This bar rules on
 *  the whole label and nothing else.
 *
 *  Exception-based by design: a row with nothing outstanding shows one calm
 *  line, not two decision buttons. Offering a verdict on a label that already
 *  passed everything manufactures doubt and trains people to click through.
 *  The override stays one quiet link away — the agent must always be able to
 *  disagree with the tool. */
function RulingBar({
  row: r,
  onReview,
  onMarkBold,
  onClearFields,
}: {
  row: BatchRow;
  onReview: (v: "ok" | "correction" | undefined) => void;
  onMarkBold: (index: number, v: "confirmed" | "flagged" | undefined) => void;
  /** clears the per-field rulings made on the comparison rows above */
  onClearFields: () => void;
}) {
  const [open, setOpen] = useState(false);
  const bucket = bucketOf(r);
  const boldOwed = boldPendingRow(r);
  const fieldsDecided = Object.keys(r.fieldReview ?? {}).length > 0;
  const decided = !!r.agentReview || !!r.boldReview || fieldsDecided;
  const show = open || decided || bucket === "review" || bucket === "error" || boldOwed;

  if (!show) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] border border-ok-line bg-ok-bg px-3 py-2">
        <span className="text-[12.5px] text-ink">
          <b className="font-semibold text-ok">Nothing to review</b> — every field matched and the warning checks passed.
        </span>
        <button
          onClick={() => setOpen(true)}
          className="ml-auto whitespace-nowrap text-[11.5px] font-semibold text-muted hover:text-ink hover:underline"
        >
          Disagree?
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-line bg-card px-3 py-2">
      <p className="shrink-0 text-[11.5px] font-semibold uppercase tracking-wider text-ink-faint">
        This label
      </p>
      <span className="min-w-0 flex-1">
        {/* Same control, same two words, as every other decision on the screen. */}
        <DecidePair
          orientation="row"
          value={r.agentReview === "ok" ? "accept" : r.agentReview === "correction" ? "reject" : null}
          onChange={(v) => onReview(v === "accept" ? "ok" : v === "reject" ? "correction" : undefined)}
          acceptLabel="Accept label"
          rejectLabel="Reject label"
          ariaPrefix="This label"
        />
      </span>
      {decided && (
        <button
          onClick={() => { onReview(undefined); onMarkBold(r.index, undefined); onClearFields(); }}
          className="shrink-0 text-[11.5px] font-semibold text-muted hover:text-ink hover:underline"
        >
          Clear
        </button>
      )}
    </div>
  );
}

/** The crop renders the label at AT LEAST this width in CSS pixels.
 *
 *  The card used to fit the whole label width into its ~230px box, so a 418px
 *  phone photo showed its warning around 4px tall — a grey smudge. Bold is
 *  judged by comparing the prefix's strokes with the body words beside it, both
 *  on the first line, so a small label has to be scaled UP, and letting the
 *  right-hand end of the line overflow the card costs nothing. Never scaled
 *  down: a large scan already reads at 1:1. */
const BOLD_CARD_MIN_RENDER_W = 640;
/** Tallest the crop box gets; past this the lower lines of the warning are
 *  clipped, which is the right thing to lose — the prefix is on line one. */
const BOLD_CARD_MAX_H = 150;
/** How much of the foot of the label to show when the warning was never
 *  located, as a fraction of the label's height.
 *
 *  Two labels in the sample batch land here: the locator returns no warning
 *  band at all for the shadowed gin, and it puts the rosé's in the wrong half
 *  of the label, after which reading the image for it fails too (its text is
 *  ~4px tall). Both cards then showed nothing but "couldn't locate the
 *  warning", which is honest and useless — the card exists so a person can
 *  look. The mandated warning sits at the foot of the label on essentially
 *  every submission, so the crop falls back to the bottom of the label,
 *  anchored to the BOTTOM edge (a top-anchored guess showed the empty space
 *  above the warning), and the card says in words that it is guessing. */
const BOLD_CARD_FALLBACK_FRAC = 0.22;
/** A guessed crop gets a taller box than a located one — it has to contain the
 *  warning wherever in the foot of the label it actually sits. */
const BOLD_CARD_GUESS_MAX_H = 190;

/** One card in the bold spot-check strip: the label's warning area cropped
 *  and zoomed (via its located band), with confirm/flag actions. Clicking
 *  the crop opens the full row. */
function BoldCard({
  row,
  onMark,
  onOpen,
}: {
  row: BatchRow;
  onMark: (index: number, v: "confirmed" | "flagged" | undefined) => void;
  onOpen: (index: number) => void;
}) {
  // Hover magnifier: the whole point of the strip is judging stroke weight
  // without opening rows, so the crop magnifies further under the cursor.
  const [lens, setLens] = useState<{ x: number; y: number } | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const isPdf = row.file?.type === "application/pdf" || row.filename.toLowerCase().endsWith(".pdf");
  // Only fall back once the locator has actually finished and come up empty —
  // while it is still working the card says so instead of guessing.
  const located = row.bands?.warning;
  const settled = row.bands !== undefined;
  const guessing = !located && settled;
  const state = row.boldReview;
  const auto = row.boldAuto;
  const cropReady = !isPdf && (!!located || guessing) && !!nat;
  // Scale the label up until it renders wide enough to read, never down.
  const scale = nat ? Math.max(1, BOLD_CARD_MIN_RENDER_W / nat.w) : 1;
  const renderedH = nat ? nat.h * scale : 0;
  // Generous padding: located bands sometimes clip the first or last line of
  // the warning, and a clipped warning can't be judged.
  const top = located ? Math.max(0, located[0] / 10 - 4) : 0;
  const bh = located ? Math.max(6, Math.min(100, located[1] / 10 + 4) - top) : BOLD_CARD_FALLBACK_FRAC * 100;
  const boxH = !nat
    ? 64
    : guessing
      ? Math.min(BOLD_CARD_GUESS_MAX_H, Math.round(BOLD_CARD_FALLBACK_FRAC * renderedH))
      : Math.min(BOLD_CARD_MAX_H, Math.max(72, Math.round((bh / 100) * nat.h * scale)));
  // A located band is shown from its top (line one carries the prefix); a guess
  // is pinned to the foot of the label, where the warning has to be.
  const shiftPct = guessing && renderedH ? Math.max(0, 100 - (boxH / renderedH) * 100) : top;
  return (
    <div
      className={`flex flex-col gap-2 rounded-[10px] border p-2.5 transition ${
        state === "flagged" ? "border-bad-line bg-red-tint/40"
          : state === "confirmed" ? "border-ok-line bg-green-tint/30"
          : auto === "bold" ? "border-ok-line bg-green-tint/20"
          : auto === "not_bold" ? "border-warn-line bg-amber-tint/40"
          : "border-line bg-card"
      }`}
    >
      <button
        onClick={() => onOpen(row.index)}
        title="Hover to magnify · click to open this label"
        onMouseMove={(e) => {
          if (!cropReady) return;
          const r = e.currentTarget.getBoundingClientRect();
          setLens({ x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 });
        }}
        onMouseLeave={() => setLens(null)}
        onPointerLeave={() => setLens(null)}
        onBlur={() => setLens(null)}
        className="relative w-full cursor-zoom-in overflow-hidden rounded-[6px] border border-paper-line bg-paper text-left"
        style={{ height: cropReady ? boxH : 64 }}
      >
        {isPdf ? (
          <span className="flex h-full items-center justify-center px-2 text-center text-[11px] font-semibold text-muted">
            PDF — open the row to view
          </span>
        ) : row.imageUrl ? (
          <>
            {/* The magnifier scales the crop about the cursor, so the strip
                answers "is this bold?" without opening a single row. */}
            <span
              className="absolute inset-0 transition-transform duration-100"
              style={lens ? { transform: "scale(2.6)", transformOrigin: `${lens.x}% ${lens.y}%` } : undefined}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={row.imageUrl}
                alt={`Warning area of ${row.filename}`}
                onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                className="absolute left-0 top-0 max-w-none"
                style={{
                  // The label renders at `scale`, so the warning's own text is
                  // legible; the box shows the band's top-left corner and lets
                  // the rest of the line run off the right edge, because the
                  // prefix and the body words beside it are the whole
                  // comparison.
                  width: nat ? `${Math.round(nat.w * scale)}px` : "100%",
                  transform: `translateY(-${shiftPct}%)`,
                  visibility: cropReady ? "visible" : "hidden",
                }}
              />
            </span>
            {!cropReady && (
              <span className="absolute inset-0 flex items-center justify-center px-2 text-center text-[11px] text-muted-2">
                finding the warning…
              </span>
            )}
          </>
        ) : null}
      </button>
      <span className="truncate text-[11.5px] font-semibold text-ink" title={row.filename}>{row.filename}</span>
      {guessing && !isPdf && (
        // Says what it is showing and what it does not know. Without this the
        // card would claim a located warning it never found.
        <span className="rounded-[5px] bg-amber-tint px-1.5 py-0.5 text-[10.5px] font-bold text-amber">
          Couldn&apos;t pinpoint the warning — showing the foot of the label. Open the row if it isn&apos;t here.
        </span>
      )}
      {!state && auto === "bold" && (
        <span className="rounded-[5px] bg-green-tint px-1.5 py-0.5 text-[10.5px] font-bold text-green">
          ✓ Verified by measurement — prefix strokes are heavier
        </span>
      )}
      {!state && auto === "not_bold" && (
        <span className="rounded-[5px] bg-amber-tint px-1.5 py-0.5 text-[10.5px] font-bold text-amber">
          Measurement says NOT bold — check this one
        </span>
      )}
      {/* Same two words as every other decision on the screen — the panel's
          Formatting row and this card write the same boldReview state, and an
          audit caught them teaching two vocabularies for one action. The
          question ("does this look bold?") lives in the copy and the titles;
          the answer is always Accept / Reject. */}
      <span className="flex gap-1.5">
        <button
          onClick={() => onMark(row.index, state === "confirmed" ? undefined : "confirmed")}
          title="Looks bold — accept the formatting"
          className={`${CTRL_BASE} flex-1 justify-center px-2 ${state === "confirmed" ? CTRL_ON.green : CTRL_IDLE}`}
        >
          {state === "confirmed" ? "Accepted ✓" : "Accept"}
        </button>
        <button
          onClick={() => onMark(row.index, state === "flagged" ? undefined : "flagged")}
          title="Not bold — reject the formatting"
          className={`${CTRL_BASE} flex-1 justify-center px-2 ${state === "flagged" ? CTRL_ON.red : CTRL_IDLE}`}
        >
          {state === "flagged" ? "Rejected" : "Reject"}
        </button>
      </span>
    </div>
  );
}
