"use client";

import { useEffect, useRef, useState } from "react";
import type { CheckResult } from "@/lib/compare/index.ts";
import type { LabelExtraction } from "@/lib/vision/contract.ts";
import type { Bands } from "@/lib/vision/locate.ts";
import { DEMO_SAMPLES, type DemoSample } from "@/lib/samples.ts";
import { downscaleImage } from "@/lib/downscale.ts";
import { applyBoldGate, type BoldGateResult } from "@/lib/compare/boldGate.ts";
import { measureBoldSignals } from "@/lib/boldMeasure.ts";
import { Shell } from "./Shell.tsx";
import { Stepper, type StepPhase, type Outcome } from "./Stepper.tsx";
import { CheckingCard } from "./CheckingCard.tsx";
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

interface OutcomeData {
  result: CheckResult;
  extraction: LabelExtraction;
  bands: Bands;
  /** time to the verdict on screen */
  ms: number;
  /** time the background second reading took, when one ran */
  confirmMs?: number;
}

function outcomeSummary(o: OutcomeData | null): Outcome {
  if (!o) return null;
  const r = o.result;
  const fieldMismatches = r.fields.filter((f) => f.verdict === "possible_mismatch" || f.verdict === "absent_on_label").length;
  const warningFails = r.warning.verdict.startsWith("fail");
  const reviews =
    r.fields.filter((f) => f.verdict === "unreadable").length + (r.warning.verdict === "unreadable" ? 1 : 0);
  if (!r.is_alcohol_label) return { tone: "warn", label: "not a label" };
  // A warning failure is a rule violation, not a field mismatch — it gets
  // its own name (vocabulary audit: red owns "fails", amber owns "confirm").
  if (warningFails && fieldMismatches === 0) return { tone: "bad", label: "warning fails" };
  if (fieldMismatches > 0) {
    const n = fieldMismatches + (warningFails ? 1 : 0);
    return { tone: "bad", label: `${n} mismatch${n === 1 ? "" : "es"}` };
  }
  if (reviews > 0) return { tone: "warn", label: `${reviews} to confirm` };
  return { tone: "ok", label: "matched" };
}

export function SingleCheck() {
  const [step, setStep] = useState<StepPhase>("form");
  const [fields, setFields] = useState<AppFields>(EMPTY);
  const [appNumber, setAppNumber] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<OutcomeData | null>(null);
  const [checkDone, setCheckDone] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [boldAuto, setBoldAuto] = useState<BoldGateResult | null>(null);
  // Guards the async confirmation against a stale merge: bumped whenever the
  // user starts a new check or resets, so a late /api/confirm response for a
  // previous label can never overwrite the current result.
  const runToken = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  function setImage(f: File) {
    setError(null);
    setFile(f);
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(f);
    });
  }
  function removeImage() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl(null);
  }
  function resetAll() {
    runToken.current++;
    removeImage();
    setFields(EMPTY);
    setAppNumber("");
    setOutcome(null);
    setError(null);
    setConfirming(false);
    setBoldAuto(null);
    setStep("form");
  }

  // Multi-signal bold gate (validated, 0 confident mistakes): when a result
  // with a passing warning and a located warning band renders, measure the
  // crop and either resolve the bold glance or leave the advisory in place.
  useEffect(() => {
    const wv = outcome?.result.warning.verdict;
    const band = outcome?.bands?.warning;
    if (!outcome || !previewUrl || !band || (wv !== "pass" && wv !== "pass_formatting_note")) return;
    if (file?.type === "application/pdf") return;
    const token = runToken.current;
    void (async () => {
      const signals = await measureBoldSignals(previewUrl, band);
      if (token !== runToken.current) return;
      setBoldAuto(applyBoldGate(signals, outcome.result.warning.boldAdvisory));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);

  async function runCheck(f: AppFields, image: File) {
    const token = ++runToken.current;
    setStep("checking");
    setCheckDone(false);
    setError(null);
    setOutcome(null);
    setConfirming(false);
    setBoldAuto(null);
    try {
      const small = image.type === "application/pdf" ? image : await downscaleImage(image);
      const form = new FormData();
      form.set("image", small);
      for (const [k, v] of Object.entries(f)) form.set(k, v);
      // Warning failures return a provisional verdict immediately; the second
      // confirming reading runs via /api/confirm and updates the row in place
      // (every label answers in ~5s instead of failing ones taking ~8s).
      form.set("async_confirm", "1");
      const res = await fetch("/api/check", { method: "POST", body: form });
      const body = await res.json().catch(() => null);
      // A newer check started while this one was in flight (overlapping
      // sample clicks) — its result owns the screen; drop this one.
      if (token !== runToken.current) return;
      if (!res.ok || !body) {
        setError(body?.error ?? "Something went wrong. Please try again.");
        setStep("form");
        return;
      }
      setOutcome({ result: body.result, extraction: body.extraction, bands: body.bands ?? {}, ms: body.ms });
      if (body.confirm_pending) {
        setConfirming(true);
        void runConfirm(small, body.result, body.extraction, token);
      }
      // Completion beat: let the checklist show all three ticks before the
      // swap — the labor illusion finishes instead of being interrupted.
      setCheckDone(true);
      setTimeout(() => setStep("result"), 250);
    } catch {
      if (token !== runToken.current) return;
      setError("Could not reach the server. Check your connection and try again.");
      setStep("form");
    }
  }

  async function runConfirm(image: File, result: CheckResult, extraction: LabelExtraction, token: number) {
    const markUnavailable = () =>
      setOutcome((prev) =>
        prev
          ? {
              ...prev,
              result: {
                ...prev.result,
                warning: {
                  ...prev.result.warning,
                  notes: [
                    "This result could not be double-checked — it is from a single reading. Check the warning on the image before acting.",
                    ...prev.result.warning.notes,
                  ],
                },
              },
            }
          : prev,
      );
    try {
      const form = new FormData();
      form.set("image", image);
      form.set("warning", JSON.stringify(result.warning));
      form.set("overall", result.overall);
      form.set("bold_advisory", extraction.warning_prefix_bold);
      if (extraction.warning_text_size) form.set("size_advisory", extraction.warning_text_size);
      const res = await fetch("/api/confirm", { method: "POST", body: form });
      const body = await res.json().catch(() => null);
      if (token !== runToken.current) return; // user moved on — drop it
      if (res.ok && body?.warning && body?.overall) {
        setOutcome((prev) =>
          prev
            ? {
                ...prev,
                result: { ...prev.result, warning: body.warning, overall: body.overall },
                // Keep `ms` as the time to the verdict on screen — folding the
                // background confirmation into it made the headline number
                // triple after the fact. The confirmation is reported apart.
                confirmMs: typeof body.ms === "number" ? body.ms : undefined,
              }
            : prev,
        );
      } else {
        markUnavailable();
      }
    } catch {
      if (token === runToken.current) markUnavailable();
    } finally {
      if (token === runToken.current) setConfirming(false);
    }
  }

  async function loadSample(s: DemoSample) {
    if (sampleLoading) return; // one sample at a time — no double-fired checks
    setSampleLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/samples/${s.png}`);
      if (!res.ok) { setError("Could not load the sample. Refresh and try again."); return; }
      const blob = await res.blob();
      const f = new File([blob], s.png, { type: "image/png" });
      const filled = { ...EMPTY, ...s.application };
      setFields(filled);
      setImage(f);
      await runCheck(filled, f);
    } catch {
      setError("Could not load the sample. Check your connection and try again.");
    } finally {
      setSampleLoading(false);
    }
  }

  const canCheck =
    file !== null &&
    Boolean(fields.brand_name.trim() || fields.class_type.trim() || fields.alcohol_content.trim() || fields.net_contents.trim());

  const input = (name: keyof AppFields, label: string, placeholder: string, optional = false) => (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-semibold text-ink-2">
        {label} {optional && <span className="font-normal text-muted-2">Optional</span>}
      </span>
      <input
        type="text"
        value={fields[name]}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => setFields((f) => ({ ...f, [name]: e.target.value }))}
        className="h-10 rounded-[7px] border border-line-input bg-card px-3 text-[13.5px] text-ink placeholder:text-muted-2 focus:border-navy focus:outline-none"
      />
    </label>
  );

  return (
    <Shell topBar={<Stepper phase={step} outcome={outcomeSummary(outcome)} />}>
      <div className="mx-auto max-w-[1120px]">
        {step === "form" && (
          <>
            <h1 className="text-[27px] font-bold tracking-[-0.5px] text-ink" style={{ textWrap: "balance" }}>
              Does the label match the application?
            </h1>
            <p className="mt-1 text-[13.5px] text-muted">
              Compare the approved application with the submitted label — it catches one-word changes in the warning text that are easy to miss by eye.
            </p>

            {error && (
              <div className="mt-4 rounded-[10px] border border-bad-line bg-red-tint p-4 text-[13.5px] font-semibold text-red">
                {error}
              </div>
            )}

            <div className="mt-5 grid rounded-xl border border-line bg-card lg:grid-cols-2 lg:divide-x lg:divide-line-soft">
              {/* Left — application details */}
              <section className="flex flex-col gap-[15px] px-7 py-6">
                <div className="flex items-baseline gap-2.5">
                  <span className="text-[11px] font-bold uppercase tracking-[0.09em] text-muted">Application details</span>
                  <input
                    type="text"
                    value={appNumber}
                    onChange={(e) => setAppNumber(e.target.value)}
                    placeholder="TTB application # (optional)"
                    aria-label="TTB application number (optional)"
                    className="w-44 border-0 border-b border-line-soft bg-transparent text-[11px] text-muted-2 placeholder:text-muted-2 focus:border-navy focus:outline-none"
                  />
                </div>
                {input("brand_name", "Brand name", "Enter brand name")}
                {input("class_type", "Class / Type", "e.g. Straight Bourbon Whiskey")}
                <div className="grid grid-cols-[1fr_140px] gap-3.5">
                  {input("alcohol_content", "Alcohol content", "e.g. 45% Alc./Vol. (90 Proof)")}
                  {input("net_contents", "Net contents", "e.g. 750 mL")}
                </div>
                {input("bottler_name_address", "Bottler name & address", "Not provided", true)}
                {input("country_of_origin", "Country of origin", "Not provided", true)}
              </section>

              {/* Right — submitted label */}
              <section className="flex flex-col gap-3 px-7 py-6">
                <span className="text-[11px] font-bold uppercase tracking-[0.09em] text-muted">Submitted label</span>
                <div
                  role="button"
                  tabIndex={0}
                  aria-label="Choose or drop a label file"
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
                  className={`flex flex-1 cursor-pointer flex-col rounded-[10px] border-[1.5px] border-dashed p-[18px] transition ${
                    dragOver ? "border-navy bg-select" : "border-[#dfe3e8] bg-[#fcfcfd]"
                  }`}
                >
                  {file && previewUrl ? (
                    <div className="flex flex-col items-center gap-2">
                      {file.type !== "application/pdf" ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={previewUrl} alt="Label preview" className="max-h-72 rounded border border-line" />
                      ) : (
                        <span className="rounded border border-line bg-card px-6 py-10 text-[13px] font-semibold text-ink">PDF</span>
                      )}
                      <span className="text-[12.5px] text-muted-2">{file.name}</span>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-2 py-6 text-center">
                      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-2" aria-hidden>
                        <path d="M7 18a4.6 4.6 0 0 1-.9-9.1 6 6 0 0 1 11.7 1.6A4 4 0 0 1 17 18h-1M12 12v8m0-8l-3 3m3-3l3 3" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span className="text-[13.5px] font-semibold text-ink">Drop the label here</span>
                      <span className="text-[12px] text-muted-2">PNG, JPG or WebP up to 8 MB · PDF up to 10 MB</span>
                      <span
                        className="mt-1 flex h-[38px] items-center rounded-[7px] border border-line-input bg-card px-4 text-[13px] font-semibold text-ink"
                      >
                        Choose file
                      </span>
                    </div>
                  )}
                </div>
                {/* Samples live OUTSIDE the clickable dropzone — a click in
                    the gutter must never launch a surprise file dialog, and
                    real buttons don't nest inside role="button" (508). */}
                {!file && (
                  <div className="flex flex-col gap-2">
                    <span className="flex w-full items-center gap-3 text-[12px] text-muted-2">
                      <span className="h-px flex-1 bg-line-soft" aria-hidden /> No label handy? <span className="h-px flex-1 bg-line-soft" aria-hidden />
                    </span>
                    <span className="text-[12px] font-bold uppercase tracking-[0.06em] text-muted-2">Try a sample</span>
                    <div className="grid w-full grid-cols-2 gap-2.5">
                      {DEMO_SAMPLES.map((s) => {
                        const dot = s.id === "clean" ? "bg-green" : s.id === "warning" ? "bg-amber" : "bg-red";
                        return (
                          <button
                            key={s.id}
                            onClick={() => loadSample(s)}
                            disabled={sampleLoading}
                            className="min-h-[70px] rounded-[9px] border border-line bg-card px-[13px] py-3 text-left transition hover:border-navy hover:bg-select disabled:cursor-wait disabled:opacity-60"
                          >
                            <span className="flex items-center gap-1.5 text-[13px] font-bold text-ink">
                              <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
                              {s.title}
                            </span>
                            <span className="block text-[12px] text-muted">{s.blurb}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {file && (
                  <div className="flex gap-4 text-[13px] font-semibold">
                    <button onClick={() => fileInput.current?.click()} className="text-navy hover:underline">Change image</button>
                    <button onClick={removeImage} className="text-muted hover:underline">Remove</button>
                  </div>
                )}
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,application/pdf"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) setImage(f); }}
                />
                <button
                  onClick={() => file && runCheck(fields, file)}
                  disabled={!canCheck}
                  className={`h-11 w-full whitespace-nowrap rounded-[7px] text-[14px] font-semibold transition ${
                    canCheck ? "bg-navy text-white hover:bg-navy-hover" : "cursor-not-allowed bg-disabled-bg text-disabled-text"
                  }`}
                >
                  Check label
                </button>
                {!canCheck && (
                  <p className="text-[12px] text-muted-2">Add a label file and at least one application field to check.</p>
                )}
                <p className="text-[12px] text-muted-2">
                  Need test files? Download a{" "}
                  {["clean-match", "case-diff", "title-case-prefix"].map((n, i) => (
                    <span key={n}>
                      {i > 0 && " · "}
                      <a href={`/api/samples/${n}.png`} download className="font-semibold text-navy hover:underline">label {i + 1}</a>
                    </span>
                  ))}{" "}
                  to upload yourself.
                </p>
              </section>
            </div>
          </>
        )}

        {step === "checking" && <CheckingCard imageUrl={previewUrl} isPdf={file?.type === "application/pdf"} complete={checkDone} />}

        {step === "result" && outcome && previewUrl && (
          <ResultView
            result={outcome.result}
            extraction={outcome.extraction}
            imageUrl={previewUrl}
            bands={outcome.bands}
            ms={outcome.ms}
            confirmMs={outcome.confirmMs}
            confirming={confirming}
            boldAuto={boldAuto}
            isPdf={file?.type === "application/pdf"}
            appNumber={appNumber}
            onPrint={() => window.print()}
            primaryAction={{ label: "Check another label", onClick: resetAll }}
          />
        )}
      </div>
    </Shell>
  );
}
