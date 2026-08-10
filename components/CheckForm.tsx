"use client";

import { useRef, useState } from "react";
import type { CheckResult } from "@/lib/compare/index.ts";
import { DEMO_SAMPLES, type DemoSample } from "@/lib/samples.ts";
import { downscaleImage } from "@/lib/downscale.ts";
import { Results } from "./Results.tsx";

interface AppFields {
  brand_name: string;
  class_type: string;
  alcohol_content: string;
  net_contents: string;
  bottler_name_address: string;
  country_of_origin: string;
}

const EMPTY: AppFields = {
  brand_name: "",
  class_type: "",
  alcohol_content: "",
  net_contents: "",
  bottler_name_address: "",
  country_of_origin: "",
};

export function CheckForm() {
  const [fields, setFields] = useState<AppFields>(EMPTY);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ result: CheckResult; ms: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  function reset() {
    setOutcome(null);
    setError(null);
  }

  function setImage(f: File) {
    reset();
    setFile(f);
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(f);
    });
  }

  async function loadSample(s: DemoSample) {
    reset();
    setBusy(true);
    try {
      const res = await fetch(`/api/samples/${s.png}`);
      if (!res.ok) {
        setError("Could not load the sample image. Refresh the page and try again.");
        return;
      }
      const blob = await res.blob();
      const f = new File([blob], s.png, { type: "image/png" });
      setFields({ ...EMPTY, ...s.application });
      setImage(f);
      // Run the check immediately — the demo is "click a sample, see a verdict".
      await runCheck({ ...EMPTY, ...s.application }, f);
    } catch {
      setError("Could not load the sample. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function runCheck(f: AppFields, image: File) {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const small = await downscaleImage(image);
      const form = new FormData();
      form.set("image", small);
      for (const [k, v] of Object.entries(f)) form.set(k, v);
      const res = await fetch("/api/check", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Something went wrong. Please try again.");
        return;
      }
      setOutcome({ result: body.result, ms: body.ms });
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const canCheck =
    file !== null &&
    (fields.brand_name.trim() ||
      fields.class_type.trim() ||
      fields.alcohol_content.trim() ||
      fields.net_contents.trim());

  const input = (name: keyof AppFields, label: string, placeholder: string, optional = false) => (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-semibold text-stone-700">
        {label} {optional && <span className="font-normal text-stone-400">(optional)</span>}
      </span>
      <input
        type="text"
        value={fields[name]}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => {
          reset();
          setFields((f) => ({ ...f, [name]: e.target.value }));
        }}
        className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-base shadow-sm focus:border-blue-500 focus:outline-none"
      />
    </label>
  );

  return (
    <div className="flex flex-col gap-8">
      {/* Try a sample — the evaluator's 3-click path */}
      <section className="rounded-xl border border-blue-200 bg-blue-50 p-4">
        <h2 className="text-base font-bold text-blue-900">New here? Try a sample</h2>
        <p className="mb-3 text-sm text-blue-900/80">
          One click loads a label and its application, and runs the check.
        </p>
        <div className="flex flex-wrap gap-2">
          {DEMO_SAMPLES.map((s) => (
            <button
              key={s.id}
              onClick={() => loadSample(s)}
              disabled={busy}
              aria-label={`Try sample: ${s.title} — ${s.blurb}`}
              className="rounded-lg border border-blue-300 bg-white px-4 py-2 text-left shadow-sm transition hover:bg-blue-100 disabled:opacity-50"
            >
              <span className="block font-semibold text-blue-900">{s.title}</span>
              <span className="block max-w-[16rem] text-xs text-stone-600">{s.blurb}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="grid gap-8 md:grid-cols-2">
        {/* Step 1: application data */}
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-bold">1. What does the application say?</h2>
          {input("brand_name", "Brand name", "e.g. OLD TOM DISTILLERY")}
          {input("class_type", "Class / type", "e.g. Kentucky Straight Bourbon Whiskey")}
          {input("alcohol_content", "Alcohol content", "e.g. 45% Alc./Vol. (90 Proof)")}
          {input("net_contents", "Net contents", "e.g. 750 mL")}
          {input("bottler_name_address", "Bottler name & address", "", true)}
          {input("country_of_origin", "Country of origin", "", true)}
        </section>

        {/* Step 2: label image */}
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-bold">2. Add the label image</h2>
          <div
            role="button"
            tabIndex={0}
            aria-label="Choose or drop a label image"
            onClick={() => fileInput.current?.click()}
            onKeyDown={(e) => e.key === "Enter" && fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) setImage(f);
            }}
            className={`flex min-h-48 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-4 text-center transition ${
              dragOver ? "border-blue-500 bg-blue-50" : "border-stone-300 bg-white hover:bg-stone-100"
            }`}
          >
            {previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewUrl} alt="Label preview" className="max-h-64 rounded-lg shadow" />
            ) : (
              <>
                <span className="text-4xl" aria-hidden>
                  🖼️
                </span>
                <span className="text-base font-semibold text-stone-700">
                  Click to choose a label image
                </span>
                <span className="text-sm text-stone-500">or drag and drop it here</span>
              </>
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setImage(f);
            }}
          />
        </section>
      </div>

      {/* Step 3: check */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => file && runCheck(fields, file)}
          disabled={!canCheck || busy}
          className="rounded-xl bg-blue-700 px-8 py-3 text-lg font-bold text-white shadow transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-stone-300"
        >
          {busy ? "Checking…" : "Check this label"}
        </button>
        {!canCheck && !busy && (
          <p className="text-sm text-stone-500">
            Add a label image and at least one application field.
          </p>
        )}
      </div>

      {error && (
        <div className="rounded-xl border-2 border-red-300 bg-red-50 p-4 text-red-900">
          <p className="font-semibold">✕ {error}</p>
        </div>
      )}

      {outcome && previewUrl && (
        <section aria-live="polite">
          <h2 className="mb-4 text-xl font-bold">Results</h2>
          <Results result={outcome.result} imageUrl={previewUrl} ms={outcome.ms} />
        </section>
      )}
    </div>
  );
}
