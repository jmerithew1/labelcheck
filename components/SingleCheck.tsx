"use client";

import { useRef, useState } from "react";
import type { CheckResult } from "@/lib/compare/index.ts";
import type { LabelExtraction } from "@/lib/vision/contract.ts";
import type { Bands } from "@/lib/vision/locate.ts";
import { DEMO_SAMPLES, type DemoSample } from "@/lib/samples.ts";
import { downscaleImage } from "@/lib/downscale.ts";
import { ResultView } from "./ResultView.tsx";

interface AppFields {
  brand_name: string;
  class_type: string;
  alcohol_content: string;
  net_contents: string;
  bottler_name_address: string;
  country_of_origin: string;
}
const EMPTY: AppFields = {
  brand_name: "", class_type: "", alcohol_content: "", net_contents: "",
  bottler_name_address: "", country_of_origin: "",
};

interface Outcome {
  result: CheckResult;
  extraction: LabelExtraction;
  bands: Bands;
  ms: number;
}

export function SingleCheck() {
  const [fields, setFields] = useState<AppFields>(EMPTY);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const reset = () => { setOutcome(null); setError(null); };

  function setImage(f: File) {
    reset();
    setFile(f);
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(f);
    });
  }

  async function runCheck(f: AppFields, image: File) {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const small = image.type === "application/pdf" ? image : await downscaleImage(image);
      const form = new FormData();
      form.set("image", small);
      for (const [k, v] of Object.entries(f)) form.set(k, v);
      const res = await fetch("/api/check", { method: "POST", body: form });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) {
        setError(body?.error ?? "Something went wrong. Please try again.");
        return;
      }
      setOutcome({ result: body.result, extraction: body.extraction, bands: body.bands ?? {}, ms: body.ms });
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function loadSample(s: DemoSample) {
    reset();
    setBusy(true);
    try {
      const res = await fetch(`/api/samples/${s.png}`);
      if (!res.ok) { setError("Could not load the example. Refresh and try again."); return; }
      const blob = await res.blob();
      const f = new File([blob], s.png, { type: "image/png" });
      setFields({ ...EMPTY, ...s.application });
      setImage(f);
      await runCheck({ ...EMPTY, ...s.application }, f);
    } catch {
      setError("Could not load the example. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const canCheck =
    file !== null &&
    Boolean(fields.brand_name.trim() || fields.class_type.trim() || fields.alcohol_content.trim() || fields.net_contents.trim());

  const input = (name: keyof AppFields, label: string, placeholder: string, optional = false) => (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-semibold text-ink">
        {label} {optional && <span className="font-normal text-ink-faint">Optional</span>}
      </span>
      <input
        type="text"
        value={fields[name]}
        placeholder={optional ? "Not provided" : placeholder}
        aria-label={label}
        onChange={(e) => { reset(); setFields((f) => ({ ...f, [name]: e.target.value })); }}
        className="rounded-lg border border-hairline bg-card px-3.5 py-2.5 text-[14px] text-ink placeholder:text-ink-faint focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy"
      />
    </label>
  );

  return (
    <div className="mx-auto max-w-6xl">
      {!outcome && (
        <div className="rounded-2xl border border-hairline bg-card p-6 md:p-8">
          <h1 className="text-[26px] font-bold tracking-tight text-ink" style={{ textWrap: "balance" }}>
            Does the label match the application?
          </h1>
          <p className="mt-1 text-[14px] text-ink-soft">Compare the approved application with the submitted label.</p>

          <div className="mt-7 grid gap-8 md:grid-cols-2">
            <section className="flex flex-col gap-4">
              <p className="text-[11.5px] font-semibold uppercase tracking-wider text-ink-faint">Application details</p>
              {input("brand_name", "Brand name", "e.g. OLD TOM DISTILLERY")}
              {input("class_type", "Class / Type", "e.g. Kentucky Straight Bourbon Whiskey")}
              <div className="grid grid-cols-2 gap-4">
                {input("alcohol_content", "Alcohol content", "e.g. 45% Alc./Vol.")}
                {input("net_contents", "Net contents", "e.g. 750 mL")}
              </div>
              {input("bottler_name_address", "Bottler name & address", "", true)}
              {input("country_of_origin", "Country of origin", "", true)}
            </section>

            <section className="flex flex-col gap-2">
              <p className="text-[11.5px] font-semibold uppercase tracking-wider text-ink-faint">Submitted label</p>
              <div
                role="button"
                tabIndex={0}
                aria-label="Choose or drop a label image or PDF"
                onClick={() => fileInput.current?.click()}
                onKeyDown={(e) => e.key === "Enter" && fileInput.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) setImage(f);
                }}
                className={`flex min-h-72 flex-1 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-4 text-center transition ${dragOver ? "border-navy bg-muted-bg" : "border-hairline bg-card hover:bg-muted-bg/60"}`}
              >
                {previewUrl && file && file.type !== "application/pdf" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={previewUrl} alt="Label preview" className="max-h-80 rounded-lg border border-hairline shadow-sm" />
                ) : file ? (
                  <p className="text-[14px] font-medium text-ink">{file.name}</p>
                ) : (
                  <>
                    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-ink-faint" aria-hidden>
                      <path d="M12 16V4m0 0L7 9m5-5l5 5M4 20h16" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span className="text-[14.5px] font-semibold text-ink">Drop the label here, or click to choose</span>
                    <span className="text-[12.5px] text-ink-faint">PNG, JPG, WebP, or PDF</span>
                  </>
                )}
              </div>
              {file && (
                <button onClick={() => fileInput.current?.click()} className="self-start text-[13px] font-semibold text-navy hover:underline">
                  Change image
                </button>
              )}
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,application/pdf"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) setImage(f); }}
              />
            </section>
          </div>

          <div className="mt-7 flex flex-wrap items-center justify-between gap-4 border-t border-hairline pt-5">
            <div className="flex flex-col gap-1.5 text-[13px]">
              <p className="text-ink-soft">
                Try an example:{" "}
                {DEMO_SAMPLES.map((s, i) => (
                  <span key={s.id}>
                    {i > 0 && <span className="text-ink-faint"> · </span>}
                    <button onClick={() => loadSample(s)} disabled={busy} className="font-semibold text-navy hover:underline disabled:opacity-50">
                      {s.title}
                    </button>
                  </span>
                ))}
              </p>
              <p className="text-ink-faint">
                No label handy?{" "}
                {["clean-match", "case-diff", "title-case-prefix"].map((n, i) => (
                  <span key={n}>
                    {i > 0 && " · "}
                    <a href={`/api/samples/${n}.png`} download className="font-medium text-navy hover:underline">
                      test label {i + 1}
                    </a>
                  </span>
                ))}{" "}
                — download, then upload it above.
              </p>
            </div>
            <button
              onClick={() => file && runCheck(fields, file)}
              disabled={!canCheck || busy}
              className="flex items-center gap-2 rounded-xl bg-navy px-6 py-3 text-[15px] font-bold text-white shadow-sm transition hover:bg-navy-hover disabled:cursor-not-allowed disabled:bg-ink-faint"
            >
              {busy ? "Checking…" : "Check label"}
              {!busy && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
                  <path d="M4 12h15m0 0l-6-6m6 6l-6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-xl border border-bad-line bg-bad-bg p-4 text-[14px] font-semibold text-bad">
          {error}
        </div>
      )}

      {outcome && previewUrl && (
        <div className="flex flex-col gap-4">
          <ResultView
            result={outcome.result}
            extraction={outcome.extraction}
            imageUrl={previewUrl}
            bands={outcome.bands}
            ms={outcome.ms}
            onPrint={() => window.print()}
          />
          <div className="no-print flex justify-end">
            <button
              onClick={() => { setOutcome(null); setFile(null); setPreviewUrl(null); setFields(EMPTY); }}
              className="flex items-center gap-2 rounded-xl bg-navy px-6 py-3 text-[15px] font-bold text-white shadow-sm transition hover:bg-navy-hover"
            >
              Check another label
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
                <path d="M4 12h15m0 0l-6-6m6 6l-6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
