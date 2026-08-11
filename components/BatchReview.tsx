"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CheckResult } from "@/lib/compare/index.ts";
import type { LabelExtraction } from "@/lib/vision/contract.ts";
import type { Bands } from "@/lib/vision/locate.ts";
import { parseCsv, toCsv } from "@/lib/csv.ts";
import { downscaleImage } from "@/lib/downscale.ts";
import { Chip, Icon } from "./chips.tsx";
import { ResultView } from "./ResultView.tsx";
import { Shell as ShellFrame } from "./Shell.tsx";

const CONCURRENCY = 8;
const PAGE_SIZE = 10;
const REQUIRED_HEADERS = ["filename", "brand_name", "class_type", "alcohol_content", "net_contents"];

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
}

function bucketOf(r: BatchRow): Bucket {
  if (r.status === "error") return "error";
  if (r.status !== "done" || !r.result) return "pending";
  if (r.result.overall === "clean") {
    const anyChecked = r.result.fields.some((f) => f.verdict !== "not_provided");
    return anyChecked ? "matched" : "not_required";
  }
  return "review";
}

/** Mockup: counts as color-coded words — mismatches red, review amber. */
function rowSummary(r: BatchRow): React.ReactNode {
  if (r.status === "error") return <span className="font-semibold text-bad">{r.error ?? "Error"}</span>;
  if (!r.result) return <span className="text-ink-faint">{r.status === "checking" ? "Checking…" : "Waiting"}</span>;
  let matched = 0, mismatch = 0, review = 0, notRequired = 0;
  for (const f of r.result.fields) {
    if (f.verdict === "match" || f.verdict === "match_formatting") matched++;
    else if (f.verdict === "possible_mismatch" || f.verdict === "absent_on_label") mismatch++;
    else if (f.verdict === "unreadable") review++;
    else notRequired++;
  }
  if (r.result.warning.verdict.startsWith("fail")) mismatch++;
  else if (r.result.warning.verdict === "unreadable") review++;
  const boldConfirm = r.result.warning.verdict === "pass" || r.result.warning.verdict === "pass_formatting_note";
  const sep = <span className="text-ink-faint">  ·  </span>;
  return (
    <>
      <span>{matched} matched</span>
      {mismatch > 0 && (<>{sep}<span className="font-semibold text-bad">{mismatch} mismatch{mismatch === 1 ? "" : "es"}</span></>)}
      {review > 0 && (<>{sep}<span className="font-semibold text-warn">{review} review</span></>)}
      {boldConfirm && (<>{sep}<span className="text-warn">bold: confirm visually</span></>)}
      {notRequired > 0 && (<>{sep}<span className="text-ink-faint">{notRequired} optional skipped</span></>)}
    </>
  );
}

const fmtTime = (d: Date) =>
  d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function BatchReview() {
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [pairingIssues, setPairingIssues] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | Bucket>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [openRow, setOpenRow] = useState<number | null>(null);
  const [tab, setTab] = useState<"overview" | "audit">("overview");
  const [wallMs, setWallMs] = useState<number | null>(null);
  const [autoRun, setAutoRun] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const filesInput = useRef<HTMLInputElement>(null);
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
    if (!parsed.length) { setGlobalError("The CSV file is empty."); return; }
    const headers = parsed[0].map((h) => h.trim().toLowerCase());
    const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
    if (missing.length) {
      setGlobalError(`The CSV is missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Download the sample CSV to see the format.`);
      return;
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
  }

  async function onFiles(list: File[]) {
    const csv = list.find((f) => f.name.toLowerCase().endsWith(".csv"));
    const media = list.filter((f) => /^image\/|application\/pdf/.test(f.type));
    if (!csv) {
      setGlobalError("Include the application CSV along with the label files (one row per application; images matched by filename).");
      return;
    }
    buildRows(await csv.text(), media);
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
  }

  // Lazy bands: fetched once per row when its detail panel opens.
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
    const header = ["filename", "overall", "government_warning", "brand_name", "class_type", "alcohol_content", "net_contents", "notes"];
    const safe = (s: string) => (/^[=+\-@]/.test(s) ? `'${s}` : s);
    const lines = [...rows].sort((a, b) => a.index - b.index).map((r) => {
      if (!r.result) return [safe(r.filename), r.status, "", "", "", "", "", r.error ? safe(`ERROR: ${r.error}`) : ""];
      const f = (n: string) => r.result!.fields.find((x) => x.field === n)?.verdict ?? "";
      return [
        safe(r.filename), r.result.overall, r.result.warning.verdict,
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
  }

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { matched: 0, review: 0, not_required: 0, error: 0, pending: 0 };
    for (const r of rows) c[bucketOf(r)]++;
    return c;
  }, [rows]);
  const done = rows.length - counts.pending;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      const b = bucketOf(r);
      if (filter !== "all" && !(filter === b || (filter === "review" && b === "error"))) return false;
      if (q && !r.filename.toLowerCase().includes(q) && !(r.application.brand_name ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
    // Problems first once the run completes (stable order while streaming so
    // rows don't jump mid-run) — page 1 must answer "what needs me?"
    if (!running && rows.every((r) => r.status !== "queued" && r.status !== "checking")) {
      const rank: Record<Bucket, number> = { error: 0, review: 1, matched: 2, not_required: 3, pending: 4 };
      return [...filtered].sort((a, b) => rank[bucketOf(a)] - rank[bucketOf(b)] || a.index - b.index);
    }
    return filtered;
  }, [rows, filter, search, running]);
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageRows = visible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const detail = rows.find((r) => r.index === openRow);

  const statusIcon = (r: BatchRow) => {
    const b = bucketOf(r);
    const cls: Record<Bucket, string> = {
      matched: "bg-ok", review: "bg-warn", error: "bg-bad", not_required: "bg-ink-faint", pending: "bg-ink-faint",
    };
    const labels: Record<Bucket, string> = {
      matched: "Matched", review: "Needs review", error: "Error", not_required: "Not required", pending: "Waiting",
    };
    const isFail = r.result?.overall === "warning_failure" || r.result?.overall === "not_a_label" ||
      r.result?.fields.some((f) => f.verdict === "possible_mismatch");
    const label = b === "review" && isFail ? "Mismatch — needs review" : labels[b];
    return (
      <span
        title={label}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white ${isFail && b === "review" ? "bg-bad" : cls[b]}`}
      >
        {b === "matched" ? Icon.check : b === "error" || isFail ? Icon.x : Icon.dot}
        <span className="sr-only">{label}</span>
      </span>
    );
  };

  const filterChip = (key: "all" | Bucket, label: string, n: number, tone: string) => (
    <button
      key={key}
      onClick={() => { setFilter(key); setPage(0); }}
      className={`rounded-lg border px-3 py-1.5 text-[13px] font-semibold transition ${
        filter === key ? "border-navy bg-navy text-white" : `border-hairline bg-card ${tone} hover:bg-muted-bg`
      }`}
    >
      {label} <span className="ml-1 rounded bg-black/10 px-1.5 text-[11.5px]">{n}</span>
    </button>
  );

  const nextReviewable = () => {
    if (openRow === null) return;
    const order = visible.map((r) => r.index);
    const at = order.indexOf(openRow);
    const nxt = order[(at + 1) % order.length];
    setOpenRow(nxt);
    setTab("overview");
  };

  const topRight = (
    <>
      <button
        onClick={exportCsv}
        disabled={done === 0}
        className="flex items-center gap-2 rounded-lg border border-hairline bg-card px-3.5 py-2 text-[13.5px] font-semibold text-ink-soft hover:bg-muted-bg disabled:opacity-40"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" strokeLinecap="round" strokeLinejoin="round"/></svg>
        Download report
      </button>
      <button
        onClick={() => { setRows([]); setPairingIssues([]); setWallMs(null); setOpenRow(null); }}
        disabled={running || rows.length === 0}
        className="rounded-lg bg-navy px-3.5 py-2 text-[13.5px] font-bold text-white hover:bg-navy-hover disabled:opacity-40"
      >
        + New batch
      </button>
    </>
  );

  return (
    <ShellFrame topRight={topRight}>
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-[26px] font-bold tracking-tight text-ink">Batch review</h1>
        <p className="text-[14px] text-ink-soft">Upload multiple labels to check them against their applications.</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        {/* Dropzone */}
        <div
          role="button"
          tabIndex={0}
          aria-label="Drop the application CSV and label files"
          onClick={() => filesInput.current?.click()}
          onKeyDown={(e) => e.key === "Enter" && filesInput.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); onFiles(Array.from(e.dataTransfer.files)); }}
          className={`flex min-h-44 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed p-6 text-center transition ${dragOver ? "border-navy bg-muted-bg" : "border-hairline bg-card hover:bg-muted-bg/60"}`}
        >
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-ink-faint" aria-hidden>
            <path d="M7 18a4.6 4.6 0 0 1-.9-9.1 6 6 0 0 1 11.7 1.6A4 4 0 0 1 17 18h-1M12 12v8m0-8l-3 3m3-3l3 3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-[14.5px] font-semibold text-ink">Drop the CSV + PDF or image files here</span>
          <span className="text-[12.5px] text-ink-faint">or</span>
          <span className="rounded-lg border border-hairline bg-card px-4 py-1.5 text-[13px] font-semibold text-ink shadow-sm">
            Choose files
          </span>
          <span className="mt-1 text-[12px] text-ink-faint">PNG, JPG, WebP up to 8 MB · PDF up to 10 MB · matched to CSV rows by filename</span>
          <span className="no-print mt-1 text-[12.5px]" onClick={(e) => e.stopPropagation()}>
            <button onClick={loadSampleBatch} disabled={running} className="font-semibold text-navy hover:underline disabled:opacity-50">Run the sample batch</button>
            <span className="text-ink-faint"> · </span>
            <a href="/api/batch-samples/batch.csv" download className="font-semibold text-navy hover:underline">sample CSV</a>
            <span className="text-ink-faint"> · </span>
            <a href="/api/batch-samples/sample-batch.zip" download className="font-semibold text-navy hover:underline">sample bundle (zip)</a>
          </span>
          <input
            ref={filesInput} type="file" multiple className="hidden"
            accept=".csv,text/csv,image/png,image/jpeg,image/webp,application/pdf"
            onChange={(e) => onFiles(Array.from(e.target.files ?? []))}
          />
        </div>

        {/* Summary card */}
        <div className="rounded-2xl border border-hairline bg-card p-5">
          <div className="flex items-center gap-2.5">
            <p className="text-[15px] font-bold text-ink">Batch summary</p>
            {rows.length > 0 && (running ? <Chip tone="info">Running</Chip> : done === rows.length && done > 0 ? <Chip tone="ok">Complete</Chip> : <Chip tone="muted">Ready</Chip>)}
          </div>
          <div className="mt-3 grid grid-cols-4 gap-2">
            {[
              { n: rows.length, l: "Total labels", cls: "text-ink" },
              { n: counts.matched, l: "Matched", cls: "text-ok" },
              { n: counts.review + counts.error, l: "Need review", cls: "text-warn" },
              { n: counts.not_required, l: "Not required", cls: "text-ink-faint" },
            ].map((t) => (
              <div key={t.l} className="rounded-xl border border-hairline p-2.5 text-center">
                <p className={`text-[22px] font-bold tabular-nums ${t.cls}`}>{t.n}</p>
                <p className="text-[11px] leading-tight text-ink-faint">{t.l}</p>
              </div>
            ))}
          </div>
          {wallMs !== null && (
            <p className="mt-2 text-[12px] text-ink-faint">Processed on {fmtTime(new Date())}</p>
          )}
          <p className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-ink-faint">
            {wallMs !== null && (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3" strokeLinecap="round"/></svg>
            )}
            {running ? `${done} of ${rows.length} checked…` : wallMs !== null ? `Checked in ${(wallMs / 1000).toFixed(1)}s` : rows.length ? "Ready to check." : "No batch loaded yet."}
          </p>
          {rows.some((r) => r.status === "queued" || (r.status === "error" && r.file)) && (
            <button
              onClick={run}
              disabled={running}
              className="mt-2 w-full rounded-xl bg-navy px-4 py-2.5 text-[14px] font-bold text-white hover:bg-navy-hover disabled:opacity-60"
            >
              {running ? `Checking… ${done}/${rows.length}` : "Check all labels"}
            </button>
          )}
        </div>
      </div>

      {globalError && (
        <div className="rounded-xl border border-bad-line bg-bad-bg p-4 text-[14px] font-semibold text-bad">{globalError}</div>
      )}
      {pairingIssues.length > 0 && (
        <div className="rounded-xl border border-warn-line bg-warn-bg p-4 text-[13px] text-warn">
          <p className="font-bold">Pairing issues — fix these before trusting results:</p>
          <ul className="mt-1 list-inside list-disc">{pairingIssues.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </div>
      )}

      {rows.length > 0 && (
        <div className={`grid items-start gap-4 ${detail ? "xl:grid-cols-[minmax(0,1fr)_460px]" : ""}`}>
          <div className="flex min-w-0 flex-col gap-3">
            {/* Filters + search */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-ink-faint">Filter by</span>
              {filterChip("all", "All", rows.length, "text-ink")}
              {filterChip("matched", "Matched", counts.matched, "text-ok")}
              {filterChip("review", "Need review", counts.review + counts.error, "text-warn")}
              {filterChip("not_required", "Not required", counts.not_required, "text-ink-faint")}
              <input
                type="search"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                placeholder="Search by file name or brand…"
                aria-label="Search results"
                className="ml-auto w-56 rounded-lg border border-hairline bg-card px-3 py-1.5 text-[13px] placeholder:text-ink-faint focus:border-navy focus:outline-none"
              />
            </div>

            {/* Table */}
            <div className="overflow-x-auto rounded-xl border border-hairline bg-card">
              <table className="w-full text-left text-[13.5px]">
                <thead className="border-b border-hairline text-[11.5px] uppercase tracking-wider text-ink-faint">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">Status</th>
                    <th className="px-2 py-2.5 font-semibold">File name</th>
                    <th className="px-2 py-2.5 font-semibold">Brand</th>
                    {/* Master-detail + narrow screens: these columns leave on
                        purpose rather than crumple (detail panel carries them). */}
                    {!detail && <th className="hidden whitespace-nowrap px-2 py-2.5 font-semibold lg:table-cell">Checked</th>}
                    {!detail && <th className="hidden whitespace-nowrap px-2 py-2.5 font-semibold lg:table-cell">Result summary</th>}
                    <th className="px-2 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r) => (
                    <tr
                      key={r.index}
                      onClick={() => { if (r.result) { setOpenRow(r.index); setTab("overview"); } }}
                      className={`border-b border-hairline last:border-0 ${r.result ? "cursor-pointer hover:bg-muted-bg/60" : ""} ${openRow === r.index ? "bg-muted-bg/80" : ""}`}
                    >
                      <td className="px-4 py-2.5">{statusIcon(r)}</td>
                      <td className="px-2 py-2.5">
                        <span className="flex items-center gap-2.5">
                          {r.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={r.imageUrl} alt="" className="h-10 w-8 shrink-0 rounded border border-hairline object-cover" />
                          ) : (
                            <span className="h-10 w-8 shrink-0 rounded border border-hairline bg-muted-bg" />
                          )}
                          <span className="min-w-0">
                            <span className="block max-w-44 truncate font-semibold text-ink">{r.filename}</span>
                            {r.file && <span className="block text-[11.5px] text-ink-faint">{(r.file.size / 1024 / 1024).toFixed(1)} MB</span>}
                          </span>
                        </span>
                      </td>
                      <td className="max-w-40 truncate px-2 py-2.5 text-ink">{r.application.brand_name}</td>
                      {!detail && (
                        <td className="hidden whitespace-nowrap px-2 py-2.5 text-[12px] text-ink-faint lg:table-cell">
                          {r.checkedAt ? <>{fmtTime(r.checkedAt)}<br />{(r.ms! / 1000).toFixed(1)}s</> : "—"}
                        </td>
                      )}
                      {!detail && (
                        <td className="hidden whitespace-nowrap px-2 py-2.5 text-[12.5px] text-ink-soft lg:table-cell">{rowSummary(r)}</td>
                      )}
                      <td className="px-2 py-2.5 text-ink-faint">
                        {r.result && (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        )}
                      </td>
                    </tr>
                  ))}
                  {pageRows.length === 0 && (
                    <tr><td colSpan={detail ? 4 : 6} className="px-4 py-6 text-center text-ink-faint">Nothing matches this filter.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between text-[12.5px] text-ink-faint">
              <span>Showing {visible.length === 0 ? 0 : page * PAGE_SIZE + 1} to {Math.min((page + 1) * PAGE_SIZE, visible.length)} of {visible.length} results</span>
              {pages > 1 && (
                <span className="flex items-center gap-1">
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    aria-label="Previous page"
                    className="h-7 w-7 rounded-lg border border-hairline bg-card text-ink-soft hover:bg-muted-bg disabled:opacity-40"
                  >
                    ‹
                  </button>
                  {Array.from({ length: pages }, (_, i) => (
                    <button
                      key={i}
                      onClick={() => setPage(i)}
                      className={`h-7 w-7 rounded-lg text-[12.5px] font-semibold ${i === page ? "bg-navy text-white" : "border border-hairline bg-card text-ink-soft hover:bg-muted-bg"}`}
                    >
                      {i + 1}
                    </button>
                  ))}
                  <button
                    onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
                    disabled={page === pages - 1}
                    aria-label="Next page"
                    className="h-7 w-7 rounded-lg border border-hairline bg-card text-ink-soft hover:bg-muted-bg disabled:opacity-40"
                  >
                    ›
                  </button>
                </span>
              )}
            </div>
          </div>

          {/* Detail panel */}
          {detail?.result && detail.extraction && detail.imageUrl && (
            <aside className="min-w-0 rounded-2xl border border-hairline bg-card p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="min-w-0 truncate text-[15px] font-bold text-ink">{detail.filename}</p>
                <div className="flex shrink-0 items-center gap-2">
                  {bucketOf(detail) === "matched" ? <Chip tone="ok">Matched</Chip> : bucketOf(detail) === "not_required" ? <Chip tone="muted">Not required</Chip> : <Chip tone="warn">Needs review</Chip>}
                  <button onClick={() => setOpenRow(null)} aria-label="Close detail" className="rounded-lg border border-hairline p-1.5 text-ink-soft hover:bg-muted-bg">
                    {Icon.x}
                  </button>
                </div>
              </div>
              <div className="mb-4 flex gap-5 border-b border-hairline">
                {(["overview", "audit"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`border-b-2 pb-2 text-[13.5px] font-semibold ${tab === t ? "border-navy text-ink" : "border-transparent text-ink-faint hover:text-ink-soft"}`}
                  >
                    {t === "overview" ? "Overview" : "Audit trail"}
                  </button>
                ))}
              </div>
              {tab === "overview" ? (
                <ResultView
                  result={detail.result}
                  extraction={detail.extraction}
                  imageUrl={detail.imageUrl}
                  bands={detail.bands ?? {}}
                  ms={detail.ms}
                  compact
                />
              ) : (
                <AuditTrail row={detail} />
              )}
              <div className="mt-4 flex items-center justify-between">
                <button onClick={() => window.print()} className="no-print rounded-xl border border-hairline px-4 py-2 text-[13px] font-semibold text-ink-soft hover:bg-muted-bg">
                  Download result
                </button>
                <button onClick={nextReviewable} className="no-print flex items-center gap-2 rounded-xl bg-navy px-5 py-2.5 text-[14px] font-bold text-white hover:bg-navy-hover">
                  Next label
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M4 12h15m0 0l-6-6m6 6l-6 6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
              </div>
            </aside>
          )}
        </div>
      )}
    </div>
    </ShellFrame>
  );
}

/** Real pipeline evidence — no decoration. */
function AuditTrail({ row }: { row: BatchRow }) {
  const r = row.result!;
  const confirmed = r.warning.notes.some((n) => /second independent/i.test(n));
  const overturned = r.warning.notes.some((n) => /readings disagree/i.test(n));
  const items: { t: string; d: string }[] = [
    { t: "File received", d: `${row.filename} (${row.file ? (row.file.size / 1024 / 1024).toFixed(1) : "?"} MB), downscaled in the browser before upload.` },
    { t: "Perception", d: `claude-haiku-4-5 transcribed the label verbatim; claude-sonnet-5 judged prefix boldness in parallel. Server time ${row.ms ? (row.ms / 1000).toFixed(1) : "?"}s.` },
    { t: "Deterministic comparison", d: "All verdicts computed in code — exact warning check vs 27 CFR 16.21, numeric ABV/volume matching, normalized text comparison. The AI never decides pass/fail." },
  ];
  if (confirmed) items.push({ t: "Second reading", d: "The warning failure was independently confirmed by a second model reading." });
  if (overturned) items.push({ t: "Second reading", d: "Two AI readings disagreed — the failure was downgraded to manual review instead of asserted." });
  items.push({
    t: "Verdict",
    d: `${r.overall.replace(/_/g, " ")} — warning: ${r.warning.verdict.replace(/_/g, " ")}; ${r.fields.filter((f) => f.verdict === "match" || f.verdict === "match_formatting").length} field(s) matched.`,
  });
  return (
    <ol className="flex flex-col gap-3">
      {items.map((it, i) => (
        <li key={i} className="rounded-xl border border-hairline p-3">
          <p className="text-[12.5px] font-bold text-ink">{it.t}</p>
          <p className="text-[12.5px] leading-snug text-ink-soft">{it.d}</p>
        </li>
      ))}
    </ol>
  );
}
