"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CheckResult } from "@/lib/compare/index.ts";
import { parseCsv, toCsv } from "@/lib/csv.ts";
import { downscaleImage } from "@/lib/downscale.ts";
import { Results } from "./Results.tsx";
import { WARNING_VERDICT_UI } from "./verdicts.tsx";

/** Batch flow: CSV manifest + label images. The browser pairs rows to images
 *  by filename, runs checks with bounded concurrency through /api/check, and
 *  streams results into a triage table — exceptions first, clean collapsed. */

const CONCURRENCY = 8;
const REQUIRED_HEADERS = ["filename", "brand_name", "class_type", "alcohol_content", "net_contents"];

type RowStatus = "queued" | "checking" | "done" | "error";

interface BatchRow {
  index: number;
  filename: string;
  application: Record<string, string>;
  file?: File;
  status: RowStatus;
  result?: CheckResult;
  ms?: number;
  error?: string;
  imageUrl?: string;
}

type Bucket = "warning_failure" | "needs_review" | "clean" | "error" | "pending";

function bucketOf(row: BatchRow): Bucket {
  if (row.status === "error") return "error";
  if (row.status !== "done" || !row.result) return "pending";
  if (row.result.overall === "warning_failure" || row.result.overall === "not_a_label")
    return "warning_failure";
  if (row.result.overall === "needs_review") return "needs_review";
  return "clean";
}

const BUCKET_ORDER: Record<Bucket, number> = {
  warning_failure: 0,
  error: 1,
  needs_review: 2,
  pending: 3,
  clean: 4,
};

export function BatchRunner() {
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [pairingIssues, setPairingIssues] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [openRow, setOpenRow] = useState<number | null>(null);
  const [showClean, setShowClean] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const csvInput = useRef<HTMLInputElement>(null);
  const imagesInput = useRef<HTMLInputElement>(null);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const startedAt = useRef<number>(0);
  const [wallMs, setWallMs] = useState<number | null>(null);
  const [autoRun, setAutoRun] = useState(false);

  // Auto-start after the sample batch loads (state must land first).
  useEffect(() => {
    if (autoRun && rows.some((r) => r.status === "queued") && !running) {
      setAutoRun(false);
      void run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, rows]);

  // One refresh mid-triage would vaporize a multi-minute, real-money run.
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (running || rows.some((r) => r.status === "done")) e.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [running, rows]);

  function buildRows(csvText: string, images: File[]): void {
    // Free blob URLs from any previous batch before dropping its rows.
    setRows((old) => {
      for (const r of old) if (r.imageUrl) URL.revokeObjectURL(r.imageUrl);
      return old;
    });
    const parsed = parseCsv(csvText);
    if (!parsed.length) {
      setGlobalError("The CSV file is empty.");
      return;
    }
    const headers = parsed[0].map((h) => h.trim().toLowerCase());
    const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
    if (missing.length) {
      setGlobalError(
        `The CSV is missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Download the sample CSV to see the expected format.`,
      );
      return;
    }
    setGlobalError(null);

    // Pair case-insensitively, tolerate extension differences.
    const issues: string[] = [];
    const imageMap = new Map<string, File>();
    const stem = (n: string) => n.toLowerCase().replace(/\.\w+$/, "");
    for (const f of images) {
      const key = stem(f.name);
      if (imageMap.has(key)) issues.push(`Two images share the name "${f.name}" — using the first.`);
      else imageMap.set(key, f);
    }
    const newRows: BatchRow[] = parsed.slice(1).map((cells, i) => {
      const rec: Record<string, string> = {};
      headers.forEach((h, j) => (rec[h] = (cells[j] ?? "").trim()));
      const file = imageMap.get(stem(rec.filename ?? ""));
      if (!file) issues.push(`Row ${i + 2}: no image found for "${rec.filename}".`);
      return {
        index: i,
        filename: rec.filename ?? "",
        application: rec,
        file,
        status: file ? ("queued" as const) : ("error" as const),
        error: file ? undefined : "No matching image uploaded",
      };
    });
    const usedStems = new Set(newRows.map((r) => stem(r.filename)));
    for (const f of images) {
      if (!usedStems.has(stem(f.name))) issues.push(`Image "${f.name}" has no CSV row — skipped.`);
    }
    setPairingIssues(issues);
    setRows(newRows);
    setWallMs(null);
  }

  async function onFilesChosen(csv: File | null, images: File[]) {
    if (!csv || !images.length) return;
    buildRows(await csv.text(), images);
  }

  async function loadSampleBatch() {
    setGlobalError(null);
    setRows([]);
    try {
      const csvRes = await fetch("/api/batch-samples/batch.csv");
      if (!csvRes.ok) {
        setGlobalError("Could not load the sample batch. Refresh and try again.");
        return;
      }
      const csvText = await csvRes.text();
      const filenames = parseCsv(csvText)
        .slice(1)
        .map((r) => r[0]?.trim())
        .filter(Boolean);
      const images = await Promise.all(
        filenames.map(async (n) => {
          const res = await fetch(`/api/batch-samples/${n}`);
          if (!res.ok) throw new Error(`sample image ${n} unavailable`);
          const blob = await res.blob();
          return new File([blob], n, { type: "image/png" });
        }),
      );
      buildRows(csvText, images);
      // The button says "run" — run. Making the user hunt for a second
      // button reads as "the tool is broken" (UX cold-read finding #1).
      setAutoRun(true);
    } catch {
      setGlobalError("Could not load the sample batch. Check your connection and try again.");
    }
  }

  async function run() {
    setRunning(true);
    startedAt.current = performance.now();
    // Error rows requeue on a re-run — a transient network blip over a
    // 2-minute batch must be recoverable without rebuilding the batch.
    const queue = rows.filter(
      (r) => r.status === "queued" || (r.status === "error" && r.file),
    );
    let next = 0;
    const update = (index: number, patch: Partial<BatchRow>) =>
      setRows((rs) => rs.map((r) => (r.index === index ? { ...r, ...patch } : r)));

    async function worker() {
      while (true) {
        const i = next++;
        if (i >= queue.length) return;
        const row = queue[i];
        update(row.index, { status: "checking" });
        try {
          const small = await downscaleImage(row.file!);
          const form = new FormData();
          form.set("image", small);
          for (const k of ["brand_name", "class_type", "alcohol_content", "net_contents", "bottler_name_address", "country_of_origin"]) {
            form.set(k, row.application[k] ?? "");
          }
          const res = await fetch("/api/check", { method: "POST", body: form });
          const body = await res.json();
          if (!res.ok) {
            update(row.index, { status: "error", error: body.error ?? `HTTP ${res.status}` });
          } else {
            update(row.index, {
              status: "done",
              result: body.result,
              ms: body.ms,
              imageUrl: URL.createObjectURL(row.file!),
            });
          }
        } catch {
          update(row.index, { status: "error", error: "Network problem — this row can be retried." });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    setWallMs(Math.round(performance.now() - startedAt.current));
    setRunning(false);
  }

  function exportCsv() {
    const header = [
      "filename", "overall", "government_warning", "brand_name", "class_type",
      "alcohol_content", "net_contents", "notes",
    ];
    // Label-transcribed text is attacker-controlled input landing in Excel:
    // neutralize formula-leading characters (=+-@) per OWASP CSV-injection.
    const safe = (s: string) => (/^[=+\-@]/.test(s) ? `'${s}` : s);
    const lines = [...rows]
      .sort((a, b) => a.index - b.index)
      .map((r) => {
        if (!r.result)
          return [safe(r.filename), r.status, "", "", "", "", "", r.error ? safe(`ERROR: ${r.error}`) : ""];
        const f = (name: string) => r.result!.fields.find((x) => x.field === name)?.verdict ?? "";
        return [
          safe(r.filename),
          r.result.overall,
          r.result.warning.verdict,
          f("brand_name"), f("class_type"), f("alcohol_content"), f("net_contents"),
          safe([...r.result.warning.notes, ...r.result.fields.map((x) => x.note).filter(Boolean)].join(" | ")),
        ];
      });
    const blob = new Blob([toCsv([header, ...lines])], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "labelcheck-results.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const counts = useMemo(() => {
    const c = { clean: 0, needs_review: 0, warning_failure: 0, error: 0, pending: 0 };
    for (const r of rows) c[bucketOf(r)]++;
    return c;
  }, [rows]);

  const done = counts.clean + counts.needs_review + counts.warning_failure + counts.error;
  const sorted = useMemo(
    () => [...rows].sort((a, b) => BUCKET_ORDER[bucketOf(a)] - BUCKET_ORDER[bucketOf(b)] || a.index - b.index),
    [rows],
  );
  const exceptions = sorted.filter((r) => bucketOf(r) !== "clean");
  const cleanRows = sorted.filter((r) => bucketOf(r) === "clean");
  const detail = rows.find((r) => r.index === openRow);

  const statusChip = (row: BatchRow) => {
    const b = bucketOf(row);
    switch (b) {
      case "warning_failure": {
        const isNotLabel = row.result?.overall === "not_a_label";
        return (
          <span className="rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-900">
            ✕ {isNotLabel ? "Not a label" : "Warning fails"}
          </span>
        );
      }
      case "needs_review":
        return <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900">⚠ Needs a look</span>;
      case "clean":
        return <span className="rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-xs font-semibold text-green-800">✓ Clean</span>;
      case "error":
        return <span className="rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-900">✕ Error</span>;
      default:
        return <span className="rounded-full border border-stone-300 bg-stone-50 px-2 py-0.5 text-xs font-semibold text-stone-600">{row.status === "checking" ? "Checking…" : "Waiting"}</span>;
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Inputs */}
      <section className="grid gap-4 md:grid-cols-[1fr_1fr_auto]">
        <button
          onClick={() => csvInput.current?.click()}
          disabled={running}
          aria-label="Choose the application CSV file"
          className="rounded-xl border-2 border-dashed border-stone-300 bg-white p-4 text-left hover:bg-stone-100 disabled:opacity-50"
        >
          <span className="block font-semibold">1. Choose the application CSV</span>
          <span className="block text-sm text-stone-500">
            {csvFile ? csvFile.name : "One row per application"}
          </span>
        </button>
        <button
          onClick={() => imagesInput.current?.click()}
          disabled={running}
          aria-label="Choose the label image files"
          className="rounded-xl border-2 border-dashed border-stone-300 bg-white p-4 text-left hover:bg-stone-100 disabled:opacity-50"
        >
          <span className="block font-semibold">2. Choose the label images</span>
          <span className="block text-sm text-stone-500">
            {imageFiles.length ? `${imageFiles.length} images selected` : "Select all images at once"}
          </span>
        </button>
        <div className="flex flex-col justify-center gap-2">
          <button
            onClick={run}
            disabled={running || !rows.some((r) => r.status === "queued" || (r.status === "error" && r.file))}
            className="rounded-xl bg-blue-700 px-6 py-3 text-lg font-bold text-white shadow hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-stone-300"
          >
            {running ? `Checking… ${done} of ${rows.length}` : "Check all labels"}
          </button>
          <button
            onClick={loadSampleBatch}
            disabled={running}
            aria-label="Load and run the bundled sample batch"
            className="rounded-lg border border-blue-300 bg-blue-50 px-4 py-1.5 text-sm font-semibold text-blue-900 hover:bg-blue-100 disabled:opacity-50"
          >
            Or run the sample batch
          </button>
        </div>
        <input
          ref={csvInput} type="file" accept=".csv,text/csv" className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setCsvFile(f);
            onFilesChosen(f, imageFiles);
          }}
        />
        <input
          ref={imagesInput} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden"
          onChange={(e) => {
            const fs = Array.from(e.target.files ?? []);
            setImageFiles(fs);
            onFilesChosen(csvFile, fs);
          }}
        />
      </section>

      <p className="text-sm text-stone-500">
        Need the format?{" "}
        <a href="/api/batch-samples/batch.csv" download className="font-semibold text-blue-700 underline">
          Download the sample CSV
        </a>
        . Images are matched to rows by filename.
      </p>

      {globalError && (
        <div className="rounded-xl border-2 border-red-300 bg-red-50 p-4 font-semibold text-red-900">
          ✕ {globalError}
        </div>
      )}

      {pairingIssues.length > 0 && (
        <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-4 text-amber-900">
          <p className="font-semibold">⚠ Pairing issues — these need attention before results are trusted:</p>
          <ul className="mt-1 list-inside list-disc text-sm">
            {pairingIssues.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Progress + summary strip */}
      {rows.length > 0 && (
        <section className="flex flex-wrap items-center gap-3 rounded-xl border border-stone-300 bg-white p-4">
          {running && (
            <progress className="h-3 w-40" max={rows.length} value={done} aria-label="Batch progress" />
          )}
          <span className="text-lg font-bold">
            {running ? `${done} of ${rows.length} checked` : `${rows.length} applications`}
          </span>
          <span className="rounded-full bg-green-50 px-3 py-1 text-sm font-semibold text-green-800">✓ {counts.clean} clean</span>
          <span className="rounded-full bg-amber-50 px-3 py-1 text-sm font-semibold text-amber-900">⚠ {counts.needs_review} {counts.needs_review === 1 ? "needs" : "need"} a look</span>
          <span className="rounded-full bg-red-50 px-3 py-1 text-sm font-semibold text-red-900">✕ {counts.warning_failure} warning {counts.warning_failure === 1 ? "failure" : "failures"}</span>
          {counts.error > 0 && (
            <span className="rounded-full bg-red-50 px-3 py-1 text-sm font-semibold text-red-900">✕ {counts.error} errors</span>
          )}
          {wallMs !== null && (
            <span className="text-sm text-stone-500">finished in {(wallMs / 1000).toFixed(0)} s</span>
          )}
          {done > 0 && (
            <button
              onClick={exportCsv}
              className="ml-auto rounded-lg border-2 border-blue-700 px-4 py-1.5 text-sm font-bold text-blue-700 hover:bg-blue-50"
            >
              ⬇ Download results (CSV)
            </button>
          )}
        </section>
      )}

      {/* Triage table: exceptions first, clean collapsed */}
      {rows.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-stone-300 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-stone-100 text-stone-600">
              <tr>
                <th className="p-3 font-semibold">Label</th>
                <th className="p-3 font-semibold">Brand (application)</th>
                <th className="p-3 font-semibold">Status</th>
                <th className="p-3 font-semibold">What to look at</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {exceptions.map((r) => (
                <BatchRowView key={r.index} row={r} statusChip={statusChip} onOpen={() => setOpenRow(r.index)} />
              ))}
              {cleanRows.length > 0 && (
                <tr className="border-t border-stone-200 bg-green-50/50">
                  <td colSpan={5} className="p-3">
                    <button onClick={() => setShowClean((s) => !s)} className="font-semibold text-green-900">
                      {showClean ? "▾" : "▸"} ✓ {cleanRows.length} clean {cleanRows.length === 1 ? "match" : "matches"} — {showClean ? "click to collapse" : "click to expand"}
                    </button>
                  </td>
                </tr>
              )}
              {showClean &&
                cleanRows.map((r) => (
                  <BatchRowView key={r.index} row={r} statusChip={statusChip} onOpen={() => setOpenRow(r.index)} />
                ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Detail: full side-by-side for one row */}
      {detail?.result && detail.imageUrl && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 md:p-10"
          onClick={() => setOpenRow(null)}
        >
          <div className="w-full max-w-5xl rounded-2xl bg-stone-50 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-bold">{detail.filename}</h2>
              <button
                onClick={() => setOpenRow(null)}
                className="rounded-lg border border-stone-300 px-4 py-1.5 font-semibold hover:bg-stone-200"
              >
                Close ✕
              </button>
            </div>
            <Results result={detail.result} imageUrl={detail.imageUrl} ms={detail.ms} />
          </div>
        </div>
      )}
    </div>
  );
}

function BatchRowView({
  row,
  statusChip,
  onOpen,
}: {
  row: BatchRow;
  statusChip: (r: BatchRow) => React.ReactNode;
  onOpen: () => void;
}) {
  const attention: string[] = [];
  const formattingNotes: string[] = [];
  if (row.result) {
    if (row.result.warning.verdict.startsWith("fail"))
      attention.push(WARNING_VERDICT_UI[row.result.warning.verdict].label);
    if (row.result.warning.verdict === "unreadable")
      attention.push("warning: check manually");
    for (const f of row.result.fields) {
      if (f.verdict === "possible_mismatch" || f.verdict === "absent_on_label" || f.verdict === "unreadable")
        attention.push(`${f.field.replace(/_/g, " ")}: ${f.note ?? f.verdict}`);
      // The table must never claim less than the detail view shows — a row
      // with formatting differences is a match, but it is not "everything
      // matches" (UX finding: summaries must be exactly as honest as details).
      if (f.verdict === "match_formatting")
        formattingNotes.push(f.field.replace(/_/g, " "));
    }
  }
  if (row.error) attention.push(row.error);
  const summary = attention.length
    ? attention.slice(0, 2).join(" · ")
    : row.status === "done"
      ? formattingNotes.length
        ? `Matches — formatting differs on ${formattingNotes.join(", ")}.`
        : "Everything matches."
      : "";
  return (
    <tr className="border-t border-stone-200 align-top hover:bg-stone-50">
      <td className="p-3 font-medium">{row.filename}</td>
      <td className="p-3">{row.application.brand_name}</td>
      <td className="p-3">{statusChip(row)}</td>
      <td className="max-w-md p-3 text-xs text-stone-600">{summary}</td>
      <td className="p-3 text-right">
        {row.result && (
          <button onClick={onOpen} className="rounded-lg border border-stone-300 px-3 py-1 text-xs font-semibold hover:bg-stone-100">
            Open
          </button>
        )}
      </td>
    </tr>
  );
}
