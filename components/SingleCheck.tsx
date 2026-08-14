"use client";

import { useEffect, useRef, useState } from "react";
import type { CheckResult } from "@/lib/compare/index.ts";
import type { LabelExtraction } from "@/lib/vision/contract.ts";
import type { Bands } from "@/lib/vision/locate.ts";
import { DEMO_SAMPLES, DOWNLOAD_SAMPLES, type DemoSample } from "@/lib/samples.ts";
import { prepareImage } from "@/lib/downscale.ts";
import { applyBoldGate, type BoldGateResult } from "@/lib/compare/boldGate.ts";
import { measureBoldSignals, ocrWarningBand } from "@/lib/boldMeasure.ts";
import { summarizeVerdict, type FieldDecision } from "@/lib/verdict.ts";
import { Shell } from "./Shell.tsx";
import { Stepper, type StepPhase, type Outcome } from "./Stepper.tsx";
import { CheckingCard } from "./CheckingCard.tsx";
import { ResultView } from "./ResultView.tsx";
import { AuditTrail } from "./AuditTrail.tsx";

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
  /** when the verdict landed — the audit trail stamps its last entry with it */
  checkedAt?: Date;
}

/** The stepper's terminal step reports the SAME verdict as the result banner,
 *  from the same tally — including the agent's own rulings. It used to run its
 *  own count that knew nothing about the bold decision, so rejecting the bold
 *  type left the top of the page saying "Result: matched". */
function outcomeSummary(
  o: OutcomeData | null,
  fieldReview: Partial<Record<string, FieldDecision>>,
  bold: { auto: BoldGateResult | null; human: "confirmed" | "flagged" | null; measuring: boolean },
  confirming: boolean,
): Outcome {
  if (!o) return null;
  if (!o.result.is_alcohol_label) return { tone: "warn", label: "not a label" };
  const s = summarizeVerdict(o.result, fieldReview, bold, confirming);
  return { tone: s.tone, label: s.short };
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
  // The stroke-width gate is running. Until it answers, the bold glance is not
  // owed — the headline says "checking" rather than asking for a confirmation
  // it is about to resolve on its own.
  const [boldMeasuring, setBoldMeasuring] = useState(false);
  // The agent's decisions on this result: per-field rulings on flagged rows
  // and the bold glance. Layered over the machine verdicts, never replacing
  // them — ResultView renders both.
  const [fieldReview, setFieldReview] = useState<Partial<Record<string, FieldDecision>>>({});
  const [boldHuman, setBoldHuman] = useState<"confirmed" | "flagged" | null>(null);
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
    setBoldMeasuring(false);
    setFieldReview({});
    setBoldHuman(null);
    setStep("form");
  }

  // Multi-signal bold gate: when a result with a passing warning renders,
  // measure the warning crop and either resolve the bold glance or leave the
  // advisory in place.
  //
  // It runs whether or not the LOCATOR found the warning. It used to bail out
  // when `bands.warning` was absent, which is how the "clean match" card came
  // back amber roughly half the time on production: the band is a model output
  // and it is sometimes simply missing, and with no band this effect never
  // started, so the glance was declared owed on a label the machine had never
  // looked at. The batch path had repaired that case since it shipped — read
  // the image for the warning and measure that — and the single-check path
  // simply never got the same treatment.
  //
  // The effect depends on `outcome` and also WRITES to it (the band
  // correction below), so it must be idempotent per band or it feeds itself.
  // It did: a corrected band that still could not be measured re-entered here,
  // failed the "did the band change?" test, wrote an identical-but-new outcome
  // object, and looped — two tesseract passes per lap, forever, while the
  // verdict sat on screen looking finished. Keying on (run, band) makes a
  // repeat a no-op, which bounds the whole path at one correction attempt.
  const boldRunKey = useRef<string | null>(null);
  useEffect(() => {
    const wv = outcome?.result.warning.verdict;
    const band = outcome?.bands?.warning;
    if (!outcome || !previewUrl || (wv !== "pass" && wv !== "pass_formatting_note")) return;
    if (file?.type === "application/pdf") return;
    const token = runToken.current;
    const key = `${token}:${band ? `${band[0]},${band[1]}` : "no-band"}`;
    if (boldRunKey.current === key) return; // already measured this exact band
    boldRunKey.current = key;
    void (async () => {
      // No band located: read the image for the warning before giving up on
      // it. A missing band is a locator miss, not an unreadable label.
      let start = band;
      if (!start) {
        const found = await ocrWarningBand(previewUrl);
        if (token !== runToken.current) return;
        if (!found) {
          setBoldAuto("human"); // genuinely cannot find it — the glance is owed
          setBoldMeasuring(false);
          return;
        }
        start = found;
        setOutcome((prev) => (prev ? { ...prev, bands: { ...prev.bands, warning: found } } : prev));
      }
      let signals = await measureBoldSignals(previewUrl, start);
      // Same correction the batch path makes: no GOVERNMENT prefix in the
      // located band usually means the band is wrong, not that the label is
      // unreadable. Read the image for the warning and retry once.
      if (!signals && band) {
        const found = await ocrWarningBand(previewUrl);
        if (token !== runToken.current) return;
        if (found && (found[0] !== start[0] || found[1] !== start[1])) {
          signals = await measureBoldSignals(previewUrl, found);
        }
        if (token !== runToken.current) return;
        // Still nothing: we do not know where the warning is, so stop drawing
        // a highlight over a band we have just disproved. The viewer says it
        // couldn't pinpoint it instead of pointing at the wrong place.
        setOutcome((prev) => {
          if (!prev) return prev;
          const bands = { ...prev.bands };
          if (found) bands.warning = found;
          else delete bands.warning;
          return { ...prev, bands };
        });
      }
      if (token !== runToken.current) return;
      setBoldAuto(applyBoldGate(signals, outcome.result.warning.boldAdvisory));
      setBoldMeasuring(false);
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
    setBoldMeasuring(false);
    setFieldReview({});
    setBoldHuman(null);
    try {
      const small = image.type === "application/pdf" ? image : await prepareImage(image);
      // Show the image the machine actually reads. prepareImage may deskew
      // (rotate) the upload, and the located bands are in the PREPARED
      // image's geometry — drawing them over the original tilted preview put
      // every highlight in the wrong place (user-reported). Same fix aligns
      // the client-side bold measurement's crop.
      if (small !== image) {
        setPreviewUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return URL.createObjectURL(small);
        });
      }
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
      setOutcome({ result: body.result, extraction: body.extraction, bands: body.bands ?? {}, ms: body.ms, checkedAt: new Date() });
      // Flag the gate as running BEFORE the effect below starts it, so the
      // first painted frame of the result never shows a bold confirmation the
      // measurement is about to resolve.
      // Not conditioned on a located band any more: with no band the effect
      // above now goes looking for the warning itself, so the gate IS running.
      setBoldMeasuring(
        (body.result.warning.verdict === "pass" || body.result.warning.verdict === "pass_formatting_note") &&
          small.type !== "application/pdf",
      );
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

  // Any field the agent has typed counts — including the two marked optional.
  // The form and /api/check must agree on this, and both used to ignore the
  // bottler and country fields, so a page that looked ready to check refused
  // the request (and with it the government-warning check, which needs no
  // application data at all).
  const canCheck = file !== null && Object.values(fields).some((v) => v.trim());

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
    <Shell
      topBar={
        <Stepper
          phase={step}
          outcome={outcomeSummary(
            outcome,
            fieldReview,
            { auto: boldAuto, human: boldHuman, measuring: boldMeasuring && boldAuto === null },
            confirming,
          )}
        />
      }
      onReenterHome={step === "form" ? undefined : resetAll}
    >
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
                        // The dot is the card's promise about its verdict, so
                        // it comes from the sample itself, not its position.
                        const dot = s.tone === "green" ? "bg-green" : s.tone === "amber" ? "bg-amber" : "bg-red";
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
                  {DOWNLOAD_SAMPLES.map((n, i) => (
                    <span key={n}>
                      {i > 0 && " · "}
                      <a href={`/api/samples/${n}`} download className="font-semibold text-navy hover:underline">label {i + 1}</a>
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
            boldHuman={boldHuman}
            boldMeasuring={boldMeasuring && boldAuto === null}
            onBoldReview={setBoldHuman}
            fieldReview={fieldReview}
            onFieldReview={(field, d) =>
              setFieldReview((fr) => {
                const next = { ...fr };
                if (d) next[field] = d;
                else delete next[field];
                return next;
              })
            }
            isPdf={file?.type === "application/pdf"}
            appNumber={appNumber}
            /* Inside the card, above the actions. Rendered after ResultView it
               sat below "Check another label", outside the main window, and
               read as missing. */
            auditTrail={
              <details className="print-open overflow-hidden rounded-xl border border-line bg-card">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-3 text-[13px] font-bold text-ink hover:bg-line-soft">
                  <span className="text-[11px] text-muted-2" aria-hidden>▸</span>
                  Audit trail — how this result was produced
                </summary>
                <div className="border-t border-line-soft px-4 py-4">
                  <AuditTrail
                    filename={file?.name ?? "label"}
                    fileSizeBytes={file?.size}
                    ms={outcome.ms}
                    checkedAt={outcome.checkedAt}
                    result={outcome.result}
                  />
                </div>
              </details>
            }
            onPrint={() => window.print()}
            primaryAction={{ label: "Check another label", onClick: resetAll }}
          />
        )}

      </div>
    </Shell>
  );
}
