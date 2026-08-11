"use client";

import { useEffect, useRef, useState } from "react";
import type { Bands, BandField } from "@/lib/vision/locate.ts";
import { resolveRegions, type Region, type FieldTexts } from "@/lib/highlight.ts";

/** Label image with zoom / fit / rotate controls and evidence overlays.
 *
 * Regions resolve progressively (AI band instantly, upgraded to OCR-exact),
 * and MULTIPLE regions render simultaneously — every issue field stays
 * highlighted (mockup 5, complex case) while the focused one gets the
 * strong border, the connector anchor, and the scroll-into-view. Highlights
 * hide while rotated (coordinates don't survive rotation honestly); focusing
 * a row resets rotation.
 */

export type Tone = "ok" | "warn" | "bad";
export const TONE_COLORS: Record<Tone, string> = {
  ok: "#167c3d",
  warn: "#b25e09",
  bad: "#b3261e",
};

export function LabelViewer({
  imageUrl,
  fieldTexts,
  bands,
  shownFields,
  focusedField,
  connectorRef,
}: {
  imageUrl: string;
  fieldTexts: FieldTexts;
  bands: Bands;
  /** every field to keep highlighted, with its verdict tone */
  shownFields: Partial<Record<BandField, Tone>>;
  focusedField: BandField | null;
  /** written with the focused overlay's element for the connector line */
  connectorRef?: React.MutableRefObject<HTMLElement | null>;
}) {
  const [regions, setRegions] = useState<Partial<Record<BandField, Region>>>({});
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusedOverlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
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
  }, [imageUrl, bands]);

  // Focusing a row resets rotation (highlights hide while rotated) and
  // scrolls the region into view.
  useEffect(() => {
    if (!focusedField) return;
    setRotation(0);
    const region = regions[focusedField];
    const el = scrollRef.current;
    if (!region || !el) return;
    const targetY = ((region.top + region.height / 2) / 100) * el.scrollHeight - el.clientHeight / 2;
    el.scrollTo({ top: Math.max(0, targetY), behavior: "smooth" });
  }, [focusedField, regions]);

  // Expose the focused overlay element for the connector line.
  useEffect(() => {
    if (connectorRef) connectorRef.current = rotation % 360 === 0 ? focusedOverlayRef.current : null;
  });

  const rotated = rotation % 360 !== 0;

  const btn = (label: string, onClick: () => void, d: string) => (
    <button
      onClick={onClick}
      aria-label={label}
      className="flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-lg border border-hairline bg-card text-ink-soft shadow-sm transition hover:bg-muted-bg"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d={d} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="text-[9.5px] font-semibold">{label}</span>
    </button>
  );

  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <div
          ref={scrollRef}
          className="max-h-[560px] overflow-auto rounded-xl border border-hairline bg-muted-bg p-3"
        >
          <div
            className="relative mx-auto origin-top transition-transform"
            style={{ width: `${zoom * 100}%`, transform: `rotate(${rotation}deg)` }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageUrl} alt="Submitted label" className="w-full rounded-md" />
            {!rotated &&
              (Object.entries(shownFields) as [BandField, Tone][]).map(([field, tone]) => {
                const region = regions[field];
                if (!region) return null;
                const color = TONE_COLORS[tone];
                const focused = field === focusedField;
                return (
                  <div
                    key={field}
                    ref={focused ? focusedOverlayRef : undefined}
                    data-overlay={field}
                    className="pointer-events-none absolute rounded-md transition-all duration-300"
                    style={{
                      left: `${region.left}%`,
                      top: `${region.top}%`,
                      width: `${region.width}%`,
                      height: `${region.height}%`,
                      border: `${focused ? 2.5 : 1.5}px solid ${color}`,
                      background: `${color}${focused ? "1c" : "10"}`,
                    }}
                  >
                    {focused && region.kind === "band" && (
                      <span className="absolute -top-0.5 right-1 -translate-y-full rounded bg-ink px-1.5 py-0.5 text-[10px] font-medium text-white">
                        approximate area
                      </span>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
        <a
          href={imageUrl}
          target="_blank"
          rel="noreferrer"
          className="no-print mt-1.5 inline-block text-[12.5px] font-semibold text-navy hover:underline"
        >
          View full size
        </a>
      </div>
      <div className="no-print flex flex-col gap-2">
        {btn("Zoom", () => setZoom((z) => (z >= 3 ? 1 : z + 0.5)), "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5M11 8v6M8 11h6")}
        {btn("Fit", () => { setZoom(1); setRotation(0); }, "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5")}
        {btn("Rotate", () => setRotation((r) => (r + 90) % 360), "M20 12a8 8 0 1 1-2.3-5.6M20 3v4h-4")}
      </div>
    </div>
  );
}
