"use client";

import { useEffect, useRef, useState } from "react";
import type { Bands, BandField } from "@/lib/vision/locate.ts";
import { resolveRegions, type Region, type FieldTexts } from "@/lib/highlight.ts";

/** Label image with zoom / fit / rotate controls and evidence overlays.
 *  Regions resolve progressively: AI band immediately, upgraded to an
 *  OCR-exact box when the browser-side read completes. Clicking a
 *  comparison row (activeField) pans/zooms to its region. */
export function LabelViewer({
  imageUrl,
  fieldTexts,
  bands,
  activeField,
  tone = "ok",
}: {
  imageUrl: string;
  fieldTexts: FieldTexts;
  bands: Bands;
  activeField: BandField | null;
  tone?: "ok" | "warn" | "bad";
}) {
  const [regions, setRegions] = useState<Partial<Record<BandField, Region>>>({});
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    // Bands render instantly; OCR-exact boxes replace them when ready.
    const immediate: Partial<Record<BandField, Region>> = {};
    for (const f of Object.keys(fieldTexts) as BandField[]) {
      const band = bands[f];
      if (band) {
        const top = Math.max(0, band[0] / 10 - 2.5);
        immediate[f] = { kind: "band", left: 0, top, width: 100, height: Math.min(100, band[1] / 10 + 2.5) - top };
      }
    }
    setRegions(immediate);
    resolveRegions(imageUrl, fieldTexts, bands).then((r) => {
      if (alive) setRegions(r);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl]);

  useEffect(() => {
    const region = activeField ? regions[activeField] : null;
    const el = scrollRef.current;
    if (!region || !el) return;
    const targetY = ((region.top + region.height / 2) / 100) * el.scrollHeight - el.clientHeight / 2;
    el.scrollTo({ top: Math.max(0, targetY), behavior: "smooth" });
  }, [activeField, regions]);

  const toneColors = { ok: "#167c3d", warn: "#b25e09", bad: "#b3261e" };
  const active = activeField ? regions[activeField] : null;

  const btn = (label: string, onClick: () => void, d: string) => (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-9 w-9 items-center justify-center rounded-lg border border-hairline bg-card text-ink-soft shadow-sm transition hover:bg-muted-bg"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d={d} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );

  return (
    <div className="flex items-start gap-2">
      <div
        ref={scrollRef}
        className="max-h-[560px] flex-1 overflow-auto rounded-xl border border-hairline bg-muted-bg p-3"
      >
        <div
          className="relative mx-auto origin-top transition-transform"
          style={{ width: `${zoom * 100}%`, transform: `rotate(${rotation}deg)` }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt="Submitted label" className="w-full rounded-md" />
          {active && (
            <div
              className="pointer-events-none absolute rounded-md transition-all duration-300"
              style={{
                left: `${active.left}%`,
                top: `${active.top}%`,
                width: `${active.width}%`,
                height: `${active.height}%`,
                border: `2.5px solid ${toneColors[tone]}`,
                background: `${toneColors[tone]}14`,
                boxShadow: "0 0 0 4000px rgba(14,31,56,0.06)",
              }}
            />
          )}
          {active?.kind === "band" && (
            <span
              className="absolute right-1 -translate-y-full rounded bg-ink px-1.5 py-0.5 text-[10px] font-medium text-white"
              style={{ top: `${active.top}%` }}
            >
              approximate area
            </span>
          )}
        </div>
      </div>
      <div className="no-print flex flex-col gap-2">
        {btn("Zoom in", () => setZoom((z) => Math.min(3, z + 0.5)), "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5M11 8v6M8 11h6")}
        {btn("Fit", () => { setZoom(1); setRotation(0); }, "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5")}
        {btn("Rotate", () => setRotation((r) => (r + 90) % 360), "M20 12a8 8 0 1 1-2.3-5.6M20 3v4h-4")}
      </div>
    </div>
  );
}
