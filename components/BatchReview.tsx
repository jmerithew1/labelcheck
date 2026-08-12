"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CheckResult } from "@/lib/compare/index.ts";
import type { LabelExtraction } from "@/lib/vision/contract.ts";
import type { Bands } from "@/lib/vision/locate.ts";
import { parseCsv, toCsv } from "@/lib/csv.ts";
import { downscaleImage } from "@/lib/downscale.ts";
import { applyBoldGate, type BoldGateResult } from "@/lib/compare/boldGate.ts";
import { measureBoldSignals } from "@/lib/boldMeasure.ts";
import { ResultView } from "./ResultView.tsx";
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
type Bucket = "matched" | "review" | "not_required" | "error" | "pending";

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
  /** Machine gate result (multi-signal, validated at 0 confident mistakes):
   *  "bold" auto-resolves the glance, "not_bold" escalates to review,
   *  "human" = measured but inconclusive. A human decision always wins. */
  boldAuto?: BoldGateResult;
}

/** Rows where the warning text passed — bold is the one element left for a
 *  human glance (the AI advisory never decides). */
const boldEligible = (r: BatchRow): boolean =>
  r.status === "done" && !!r.result &&
  (r.result.warning.verdict === "pass" || r.result.warning.verdict === "pass_formatting_note");

function bucketOf(r: BatchRow): Bucket {
  if (r.status === "error") return "error";
  if (r.status !== "done" || !r.result) return "pending";
  // An agent's flag outranks the clean verdict — a human said "not bold."
  if (r.boldReview === "flagged") return "review";
  // A confident machine "not bold" escalates too, unless a human overruled it.
  if (r.boldAuto === "not_bold" && r.boldReview !== "confirmed") return "review";
  if (r.result.overall === "clean") {
    const anyChecked = r.result.fields.some((f) => f.verdict !== "not_provided");
    return anyChecked ? "matched" : "not_required";
  }
  return "review";
}

const fmtTime = (d: Date) =>
  d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function rowSummary(r: BatchRow): React.ReactNode {
  if (r.status === "error") return <span className="font-semibold text-red">{r.error ?? "Error"}</span>;
  if (!r.result) return <span className="text-muted-2">{r.status === "checking" ? "Checking…" : "Waiting"}</span>;
  let matched = 0, mismatch = 0, review = 0, notRequired = 0;
  for (const f of r.result.fields) {
    if (f.verdict === "match" || f.verdict === "match_formatting") matched++;
    else if (f.verdict === "possible_mismatch" || f.verdict === "absent_on_label") mismatch++;
    else if (f.verdict === "unreadable") review++;
    else notRequired++;
  }
  if (r.result.warning.verdict.startsWith("fail")) mismatch++;
  else if (r.result.warning.verdict === "unreadable") review++;
  // The bold-confirm marker stays in batch summaries — the tool's one blind
  // spot never hides behind a clean-looking row (behavioral audit finding).
  // It resolves only when a human glances: confirmed clears it, flagged
  // escalates it.
  const boldState = boldEligible(r)
    ? r.boldReview ?? (r.boldAuto === "bold" ? "auto" : r.boldAuto === "not_bold" ? "auto_flag" : "confirm")
    : null;
  const sep = <span className="text-muted-2"> • </span>;
  return (
    <>
      <span>{matched} matched</span>
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
  const boldFetching = useRef<Set<number>>(new Set());
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

  function buildRows(csvText: string, images: File[]) {
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
    setGlobalError(null);
    const issues: string[] = [];
    const imageMap = new Map<string, File>();
    const stem = (n: string) => n.toLowerCase().replace(/\.\w+$/, "");
    for (const f of images) {
      const key = stem(f.name);
      if (imageMap.has(key)) issues.push(`Two files share the name "${f.name}" — using the first.`);
      else imageMap.set(key, f);
    }
    const newRows: BatchRow[] = parsed.slice(1).map((cells, i) => {
      const rec: Record<string, string> = {};
      headers.forEach((h, j) => (rec[h] = (cells[j] ?? "").trim()));
      const file = imageMap.get(stem(rec.filename ?? ""));
      if (!file) issues.push(`Row ${i + 2}: no label file found for "${rec.filename}".`);
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
    setStripDismissed(false);
    boldFetching.current.clear();
    return issues.length === 0 && newRows.length > 0;
  }

  async function onFiles(list: File[]) {
    const csv = list.find((f) => f.name.toLowerCase().endsWith(".csv"));
    const media = list.filter((f) => /^image\/|application\/pdf/.test(f.type));
    if (!csv) {
      setGlobalError("Include the spreadsheet (CSV) along with the label files — one row per application; labels are matched to rows by file name.");
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
          const small = row.file!.type === "application/pdf" ? row.file! : await downscaleImage(row.file!);
          const form = new FormData();
          form.set("image", small);
          form.set("skip_locate", "1");
          for (const k of ["brand_name", "class_type", "alcohol_content", "net_contents", "bottler_name_address", "country_of_origin"]) {
            form.set(k, row.application[k] ?? "");
          }
          const res = await fetch("/api/check", { method: "POST", body: form });
          const body = await res.json().catch(() => null);
          if (!res.ok || !body) update(row.index, { status: "error", error: body?.error ?? `HTTP ${res.status}` });
          else update(row.index, { status: "done", result: body.result, extraction: body.extraction, ms: body.ms, checkedAt: new Date() });
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

  // Warning bands for the bold gate + strip: once the run settles, fetch for
  // every eligible row without bands, a few at a time — the machine gate
  // resolves what it can before anything is asked of the human. In-flight
  // indexes are tracked in a ref so re-renders never duplicate a fetch.
  useEffect(() => {
    if (running) return;
    const targets = rows.filter(
      (r) => boldEligible(r) && !r.bands && r.file && r.file.type !== "application/pdf" && !boldFetching.current.has(r.index),
    );
    if (!targets.length) return;
    let alive = true;
    let next = 0;
    async function worker() {
      while (alive) {
        const t = targets[next++];
        if (!t) return;
        // Claim the row only when actually starting it — a worker killed by a
        // re-render must not leave unstarted rows marked in-flight forever.
        if (boldFetching.current.has(t.index)) continue;
        boldFetching.current.add(t.index);
        try {
          const small = await downscaleImage(t.file!);
          const form = new FormData();
          form.set("image", small);
          const res = await fetch("/api/locate", { method: "POST", body: form });
          const body = await res.json().catch(() => null);
          // {} marks "tried, nothing found" so the card can say so honestly.
          setRows((rs) => rs.map((r) => (r.index === t.index ? { ...r, bands: body?.bands ?? {} } : r)));
        } catch {
          /* retryable on the next effect run */
        } finally {
          boldFetching.current.delete(t.index);
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, rows]);

  const setBoldReview = (index: number, v: "confirmed" | "flagged" | undefined) =>
    setRows((rs) => rs.map((r) => (r.index === index ? { ...r, boldReview: v } : r)));

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
  // machine result yet, measure and gate it (validated at 0 confident
  // mistakes — see lib/compare/boldGate.ts). Claim-on-start dedupe; the OCR
  // worker serializes internally.
  const gateRunning = useRef<Set<number>>(new Set());
  useEffect(() => {
    // Rows the machine can never measure (PDFs, no image, band lookup came
    // back without a warning) go straight to "human" so the attention-only
    // strip can show them.
    const unmeasurable = rows.filter(
      (r) =>
        boldEligible(r) && r.boldAuto === undefined &&
        (r.file?.type === "application/pdf" || !r.imageUrl || (r.bands !== undefined && !r.bands.warning)),
    );
    if (unmeasurable.length) {
      const idx = new Set(unmeasurable.map((r) => r.index));
      setRows((rs) => rs.map((r) => (idx.has(r.index) ? { ...r, boldAuto: "human" } : r)));
    }
    const targets = rows.filter(
      (r) =>
        boldEligible(r) && r.boldAuto === undefined && r.bands?.warning && r.imageUrl &&
        r.file && r.file.type !== "application/pdf" && !gateRunning.current.has(r.index),
    );
    for (const t of targets) {
      gateRunning.current.add(t.index);
      void (async () => {
        try {
          const signals = await measureBoldSignals(t.imageUrl!, t.bands!.warning!);
          const verdict = applyBoldGate(signals, t.result!.warning.boldAdvisory);
          setRows((rs) => rs.map((r) => (r.index === t.index ? { ...r, boldAuto: verdict } : r)));
        } catch {
          setRows((rs) => rs.map((r) => (r.index === t.index ? { ...r, boldAuto: "human" } : r)));
        } finally {
          gateRunning.current.delete(t.index);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  // Lazy bands for the open detail row.
  useEffect(() => {
    const row = rows.find((r) => r.index === openRow);
    if (!row || row.bands || !row.file || row.status !== "done" || row.file.type === "application/pdf") return;
    let alive = true;
    (async () => {
      try {
        const small = await downscaleImage(row.file!);
        const form = new FormData();
        form.set("image", small);
        const res = await fetch("/api/locate", { method: "POST", body: form });
        const body = await res.json().catch(() => null);
        if (alive && body?.bands) {
          setRows((rs) => rs.map((r) => (r.index === row.index ? { ...r, bands: body.bands } : r)));
        }
      } catch { /* highlights degrade silently */ }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRow]);

  function exportCsv() {
    const header = ["filename", "overall", "government_warning", "bold_check", "brand_name", "class_type", "alcohol_content", "net_contents", "notes"];
    const safe = (s: string) => (/^[=+\-@]/.test(s) ? `'${s}` : s);
    const lines = [...rows].sort((a, b) => a.index - b.index).map((r) => {
      if (!r.result) return [safe(r.filename), r.status, "", "", "", "", "", "", r.error ? safe(`ERROR: ${r.error}`) : ""];
      const f = (n: string) => r.result!.fields.find((x) => x.field === n)?.verdict ?? "";
      // The bold record: a human decision wins; otherwise the machine gate's
      // result; otherwise unconfirmed. Only for labels whose text passed.
      const bold = boldEligible(r)
        ? r.boldReview ??
          (r.boldAuto === "bold" ? "auto_verified" : r.boldAuto === "not_bold" ? "auto_flagged" : "unconfirmed")
        : "";
      return [
        safe(r.filename), r.result.overall, r.result.warning.verdict, bold,
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
    const c: Record<Bucket, number> = { matched: 0, review: 0, not_required: 0, error: 0, pending: 0 };
    for (const r of rows) c[bucketOf(r)]++;
    return c;
  }, [rows]);
  const done = rows.length - counts.pending;
  const boldRows = useMemo(() => rows.filter(boldEligible), [rows]);
  // Machine-verified rows are resolved; machine-flagged and inconclusive
  // rows still need eyes — those are the only ones the strip shows.
  const boldPendingRows = useMemo(
    () => boldRows.filter((r) => !r.boldReview && r.boldAuto !== "bold" && r.boldAuto !== undefined),
    [boldRows],
  );
  const boldPending = boldRows.filter((r) => !r.boldReview && r.boldAuto !== "bold").length;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      const b = bucketOf(r);
      if (filter !== "all" && !(filter === b || (filter === "review" && b === "error"))) return false;
      if (q && !r.filename.toLowerCase().includes(q) && !(r.application.brand_name ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
    if (!running && rows.every((r) => r.status !== "queued" && r.status !== "checking")) {
      const rank: Record<Bucket, number> = { error: 0, review: 1, matched: 2, not_required: 3, pending: 4 };
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

  const statusDot = (r: BatchRow, size = 22) => {
    const b = bucketOf(r);
    const isFail = r.result?.overall === "warning_failure" || r.result?.overall === "not_a_label" ||
      r.result?.fields.some((f) => f.verdict === "possible_mismatch");
    const cls =
      b === "matched" ? "bg-green" : b === "error" || isFail ? "bg-red" : b === "review" ? "bg-amber" : "bg-na";
    const labels: Record<Bucket, string> = {
      matched: "Matched", review: "Needs review", error: "Error", not_required: "Not required", pending: "Waiting",
    };
    const label = b === "review" && isFail ? "Mismatch — needs review" : labels[b];
    const glyph = b === "matched" ? "✓" : b === "error" || isFail ? "✕" : b === "review" ? "!" : "–";
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
    const isFail = r.result?.overall === "warning_failure" || r.result?.overall === "not_a_label" ||
      r.result?.fields.some((f) => f.verdict === "possible_mismatch");
    const label = b === "matched" ? "Matched" : b === "error" ? "Error" : b === "review" ? (isFail ? "Mismatch" : "Needs review") : b === "not_required" ? "Not required" : "Waiting";
    const cls = b === "matched" ? "bg-green-tint text-green" : b === "error" || isFail ? "bg-red-tint text-red" : b === "review" ? "bg-amber-tint text-amber" : "bg-na-tint text-muted";
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
      <span className="ml-auto flex items-center gap-2">
        <button
          onClick={exportCsv}
          disabled={done === 0}
          className="flex h-9 items-center gap-1.5 rounded-[7px] border border-line-input bg-card px-3 text-[13px] font-semibold text-ink-2 hover:bg-line-soft disabled:opacity-40"
        >
          ↓ Download report (CSV)
        </button>
        <button
          onClick={() => {
            // The one truly irreversible act in the app — nothing is stored.
            if (done > 0 && !exportedSince) {
              if (!window.confirm(`This clears all ${rows.length} results and nothing is stored. Download the report first?`)) return;
            }
            setRows([]); setPairingIssues([]); setWallMs(null); setOpenRow(null); setVisited(new Set());
          }}
          disabled={running || rows.length === 0}
          className="h-9 rounded-[7px] bg-navy px-3 text-[13px] font-bold text-white hover:bg-navy-hover disabled:opacity-40"
        >
          + New batch
        </button>
      </span>
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
            <a href="/api/batch-samples/batch.csv" download className="font-semibold text-navy hover:underline">sample CSV</a>
            <span className="text-muted-2"> · </span>
            <a href="/api/batch-samples/sample-batch.zip" download className="font-semibold text-navy hover:underline">sample bundle (zip)</a>
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

            {running && done > 0 && (
              <p className="mb-3 text-[12.5px] text-muted" role="status">
                {(() => {
                  const doneRows = rows.filter((r) => r.ms);
                  const avg = doneRows.length ? doneRows.reduce((a, r) => a + r.ms!, 0) / doneRows.length : 4000;
                  const etaS = Math.ceil(((rows.length - done) * avg) / CONCURRENCY / 1000);
                  return `About ${etaS >= 60 ? `${Math.ceil(etaS / 60)} min` : `${etaS}s`} left · finished rows are ready — you can start reviewing while the rest run.`;
                })()}
              </p>
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
                    {boldRows.length - boldPendingRows.length > 0
                      ? `${boldRows.length - boldPendingRows.length} of ${boldRows.length} verified by measurement — these ${boldPendingRows.length === 1 ? "is the one" : `are the ${boldPendingRows.length}`} that need your eyes. Confirm the ones that look bold, flag any that don't.`
                      : "Bold is the one check that needs your eyes. Glance at each warning below — confirm the ones that look bold, flag any that don't."}
                  </p>
                  <span className="ml-auto whitespace-nowrap rounded-[5px] bg-amber-tint px-2 py-0.5 text-[11.5px] font-bold text-amber">
                    {boldPendingRows.length} left
                  </span>
                  <button onClick={() => setStripDismissed(true)} aria-label="Hide bold confirmation" className="flex h-7 w-7 items-center justify-center rounded-[6px] text-ink-2 hover:bg-line-soft">✕</button>
                </div>
                <div className="grid gap-3 p-4 [grid-template-columns:repeat(auto-fill,minmax(230px,1fr))]">
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
                {chip("not_required", "Not required", counts.not_required, "na")}
                {boldPending > 0 && (
                  <button
                    onClick={() => setStripDismissed((s) => !s)}
                    title="Bold checks that still need a human glance — the measurement gate resolved the rest"
                    className={`flex h-8 items-center gap-1.5 rounded-[7px] border px-3 text-[12.5px] font-semibold transition ${
                      !stripDismissed ? "border-amber bg-amber-tint text-amber" : "border-line bg-card text-ink-2 hover:bg-line-soft"
                    }`}
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
                  { c: "bg-green-dark", t: "How it decides", d: <>Fixed rules in the software make every pass or fail; the AI only reads the label. <b>Type size and physical checks stay manual.</b></> },
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
                  {tab === "overview" ? (
                    <ResultView
                      result={detail.result!}
                      extraction={detail.extraction!}
                      imageUrl={detail.imageUrl!}
                      bands={detail.bands ?? {}}
                      ms={detail.ms}
                      boldAuto={detail.boldReview ? null : detail.boldAuto ?? null}
                      isPdf={detail.filename.toLowerCase().endsWith(".pdf")}
                      compact
                    />
                  ) : (
                    <AuditTrail row={detail} />
                  )}
                </div>
                <div className="flex items-center justify-between border-t border-line px-6 py-3">
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
              </>
            );
            return (
              /* Pinned within the viewport: header, tabs, scrollable body AND
                 the Review-next footer all stay on screen (conformance #3). */
              <aside className="sticky top-3 ml-4 hidden h-[calc(100vh-24px)] w-[clamp(360px,34vw,480px)] flex-col overflow-hidden rounded-xl border border-line bg-card xl:flex">
                {panelInner}
              </aside>
            );
          })()}
        </div>
      )}

      {/* Below xl: the same panel renders inline under the table. */}
      {rows.length > 0 && detail?.result && detail.extraction && detail.imageUrl && (
        <section className="mt-4 flex max-h-[80vh] flex-col rounded-xl border border-line bg-card xl:hidden">
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
            {tab === "overview" ? (
              <ResultView result={detail.result} extraction={detail.extraction} imageUrl={detail.imageUrl} bands={detail.bands ?? {}} ms={detail.ms} boldAuto={detail.boldReview ? null : detail.boldAuto ?? null} isPdf={detail.filename.toLowerCase().endsWith(".pdf")} compact />
            ) : (
              <AuditTrail row={detail} />
            )}
          </div>
          <div className="flex items-center justify-between border-t border-line px-6 py-3">
            <span className="text-[12px] text-muted-2">Label {orderPos + 1} of {order.length}</span>
            <button onClick={() => stepPanel(1)} className="h-[38px] rounded-[7px] bg-navy px-4 text-[13px] font-bold text-white hover:bg-navy-hover">
              {atLast ? "Done — back to list" : "Review next"}
            </button>
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
  const [aspect, setAspect] = useState<number | null>(null);
  const isPdf = row.file?.type === "application/pdf" || row.filename.toLowerCase().endsWith(".pdf");
  const band = row.bands?.warning;
  const tried = row.bands !== undefined;
  const top = band ? Math.max(0, band[0] / 10 - 1.5) : 0;
  const bh = band ? Math.max(4, Math.min(100, band[1] / 10 + 1.5) - top) : 0;
  const state = row.boldReview;
  const auto = row.boldAuto;
  const cropReady = !isPdf && !!band && aspect !== null;
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
        title="Open this label"
        className="relative w-full overflow-hidden rounded-[6px] border border-paper-line bg-paper text-left"
        style={cropReady ? { aspectRatio: `${100 / (aspect! * bh)}`, maxHeight: 120 } : { height: 64 }}
      >
        {isPdf ? (
          <span className="flex h-full items-center justify-center px-2 text-center text-[11px] font-semibold text-muted">
            PDF — open the row to view
          </span>
        ) : row.imageUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={row.imageUrl}
              alt={`Warning area of ${row.filename}`}
              onLoad={(e) => setAspect(e.currentTarget.naturalHeight / e.currentTarget.naturalWidth)}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(-${top}%)`, visibility: cropReady ? "visible" : "hidden" }}
            />
            {!cropReady && (
              <span className={`absolute inset-0 flex items-center justify-center px-2 text-center text-[11px] text-muted-2 ${tried && !band ? "" : "animate-pulse"}`}>
                {tried && !band ? "couldn't locate the warning — open the row" : "finding the warning…"}
              </span>
            )}
          </>
        ) : null}
      </button>
      <span className="truncate text-[11.5px] font-semibold text-ink" title={row.filename}>{row.filename}</span>
      {!state && auto === "bold" && (
        <span className="rounded-[5px] bg-green-tint px-1.5 py-0.5 text-[10.5px] font-bold text-green">
          ✓ Verified by measurement — stroke width + AI agree
        </span>
      )}
      {!state && auto === "not_bold" && (
        <span className="rounded-[5px] bg-amber-tint px-1.5 py-0.5 text-[10.5px] font-bold text-amber">
          Measurement says NOT bold — check this one
        </span>
      )}
      <span className="flex gap-1.5">
        <button
          onClick={() => onMark(row.index, state === "confirmed" ? undefined : "confirmed")}
          className={`h-7 flex-1 rounded-[6px] border text-[11.5px] font-bold transition ${
            state === "confirmed" ? "border-green bg-green text-white" : "border-line bg-card text-green hover:bg-green-tint"
          }`}
        >
          {state === "confirmed" ? "Bold ✓" : "Looks bold"}
        </button>
        <button
          onClick={() => onMark(row.index, state === "flagged" ? undefined : "flagged")}
          className={`h-7 flex-1 rounded-[6px] border text-[11.5px] font-bold transition ${
            state === "flagged" ? "border-red bg-red text-white" : "border-line bg-card text-red hover:bg-red-tint"
          }`}
        >
          {state === "flagged" ? "Flagged" : "Not bold — flag"}
        </button>
      </span>
    </div>
  );
}

/** Audit trail (design timeline style, REAL entries — no fake confidence
 *  numbers, and an honest closing note: nothing is stored). */
function AuditTrail({ row }: { row: BatchRow }) {
  const r = row.result!;
  const confirmed = r.warning.notes.some((n) => /second independent/i.test(n));
  const overturned = r.warning.notes.some((n) => /readings.*disagree/i.test(n));
  const ts = row.checkedAt ? row.checkedAt.toLocaleTimeString() : undefined;
  // Plain English first (Margaret finding #1); technical identifiers in
  // parentheses for auditors who need them.
  const items: { t: string; d: string }[] = [
    { t: "Label uploaded", d: `${row.filename}${row.file ? ` (${(row.file.size / 1024 / 1024).toFixed(1)} MB)` : ""} — shrunk in your browser before sending.` },
    { t: "Text read from the label", d: `The computer read the label word for word, exactly as printed, and separately judged whether the warning is in bold type. Took ${row.ms ? (row.ms / 1000).toFixed(1) : "?"} seconds (readers: claude-haiku-4-5, claude-sonnet-5).` },
    { t: "Compared to the application", d: "Fixed rules in the software — not the AI — decide every pass or fail: the warning must match the required text exactly (27 CFR 16.21), and the other fields are compared with sensible tolerance for formatting." },
  ];
  if (confirmed) items.push({ t: "Second opinion", d: "Because the warning failed, a second independent reading was taken. It agreed — the failure stands." });
  if (overturned) items.push({ t: "Second opinion", d: "Two independent readings disagreed, so instead of asserting a failure this row was marked for a manual look." });
  items.push({
    t: "Result recorded",
    d: `${r.overall.replace(/_/g, " ")} — warning: ${r.warning.verdict.replace(/_/g, " ")}; ${r.fields.filter((f) => f.verdict === "match" || f.verdict === "match_formatting").length} field(s) matched.`,
  });
  return (
    <div className="flex flex-col">
      <ol className="flex flex-col">
        {items.map((it, i) => (
          <li key={i} className="relative pb-4 pl-5 last:pb-0">
            {i < items.length - 1 && <span className="absolute left-[4px] top-3 h-full w-[1.5px] bg-line" aria-hidden />}
            <span className="absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full bg-navy" aria-hidden />
            <p className="text-[13px] font-bold text-ink">
              {it.t} {ts && i === items.length - 1 && <span className="ml-1 font-normal text-[11.5px] text-muted-2">{ts}</span>}
            </p>
            <p className="text-[12.5px] leading-snug text-muted">{it.d}</p>
          </li>
        ))}
      </ol>
      <p className="mt-4 border-t border-line-soft pt-3 text-[12px] text-muted-2">
        The AI never decides pass or fail — it only reads. Nothing is stored: the evidence lives in this browser session only.
      </p>
    </div>
  );
}
