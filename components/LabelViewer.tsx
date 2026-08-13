"use client";

import { useEffect, useRef, useState } from "react";
import type { Bands, BandField } from "@/lib/vision/locate.ts";
import { resolveRegions, type Region, type FieldTexts } from "@/lib/highlight.ts";

/** v2 label viewer (design §Result card / SUBMITTED LABEL): fixed viewport
 *  with overflow hidden, control row − / zoom % / + · Rotate · Fit ·
 *  View full size (lightbox keeps the evidence overlays). Regions resolve
 *  progressively: AI band instantly, upgraded to OCR-exact; multiple issue
 *  regions render simultaneously; highlights hide while rotated. */

export type Tone = "ok" | "warn" | "bad";
export const TONE_COLORS: Record<Tone, string> = {
  ok: "#178a52",
  warn: "#c77700",
  bad: "#d13b3b",
};

export function LabelViewer({
  imageUrl,
  isPdf = false,
  fieldTexts,
  bands,
  shownFields,
  focusedField,
  connectorRef,
  viewportHeight = 340,
}: {
  imageUrl: string;
  /** PDFs can't render in <img> — show an honest placeholder instead */
  isPdf?: boolean;
  fieldTexts: FieldTexts;
  bands: Bands;
  shownFields: Partial<Record<BandField, Tone>>;
  focusedField: BandField | null;
  connectorRef?: React.MutableRefObject<HTMLElement | null>;
  viewportHeight?: number;
}) {
  const [regions, setRegions] = useState<Partial<Record<BandField, Region>>>({});
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [fullSize, setFullSize] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusedOverlayRef = useRef<HTMLDivElement>(null);
  // Drag-to-pan while zoomed: without it, zoom shows one fixed window of the
  // label and the controls are useless for inspecting a specific area.
  const drag = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);

  useEffect(() => {
    if (!fullSize) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFullSize(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullSize]);

  useEffect(() => {
    if (isPdf) return; // no pixels to resolve against
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

  useEffect(() => {
    if (!focusedField) return;
    setRotation(0);
    const region = regions[focusedField];
    const el = scrollRef.current;
    if (!region || !el) return;
    const targetY = ((region.top + region.height / 2) / 100) * el.scrollHeight - el.clientHeight / 2;
    el.scrollTo({ top: Math.max(0, targetY), behavior: "smooth" });
  }, [focusedField, regions]);

  useEffect(() => {
    if (connectorRef) connectorRef.current = rotation % 360 === 0 ? focusedOverlayRef.current : null;
  });

  const rotated = rotation % 360 !== 0;

  // Browsers can't render a PDF inside <img>; show an honest placeholder
  // instead of a broken image with dead zoom controls. Verdicts, notes, and
  // diffs above are unaffected — only on-image highlighting is unavailable.
  if (isPdf) {
    return (
      <div className="flex flex-col gap-2.5">
        <div
          className="flex items-center justify-center rounded-[10px] border border-line bg-line-soft/40 p-3"
          style={{ height: viewportHeight }}
        >
          <div className="flex flex-col items-center gap-2.5 text-center">
            <span className="rounded border border-line bg-card px-6 py-8 text-[13px] font-semibold text-ink">PDF</span>
            <span className="max-w-[250px] text-[12px] text-muted-2">
              PDF files can&rsquo;t be previewed here — open the file to see the label. Every check above still ran on it.
            </span>
          </div>
        </div>
      </div>
    );
  }

  const overlays = (focusable: boolean) =>
    (Object.entries(shownFields) as [BandField, Tone][]).map(([field, tone]) => {
      const region = regions[field];
      if (!region) return null;
      const color = TONE_COLORS[tone];
      const focused = focusable && field === focusedField;
      return (
        <div
          key={field}
          ref={focused ? focusedOverlayRef : undefined}
          data-conn-reg={field}
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
            <span className="absolute -top-0.5 right-1 -translate-y-full rounded bg-navy px-1.5 py-0.5 text-[10px] font-medium text-white">
              approximate area
            </span>
          )}
        </div>
      );
    });

  const ctrl = (label: string, onClick: () => void, content: React.ReactNode, disabled = false) => (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      disabled={disabled}
      className="flex h-[30px] min-w-[30px] items-center justify-center rounded-[6px] border border-line-input bg-card px-1.5 text-[13px] font-semibold text-ink-2 transition hover:bg-line-soft disabled:opacity-40"
    >
      {content}
    </button>
  );

  // The locator is best-effort: when the focused field has no resolvable
  // region, say so instead of doing nothing — a click that changes nothing
  // reads as a broken button (user-reported).
  const focusedUnlocated = focusedField !== null && !regions[focusedField];

  return (
    <div className="relative flex flex-col gap-2.5">
      {focusedUnlocated && (
        <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center">
          <span className="rounded-full border border-warn-line bg-warn-bg px-3 py-1 text-[12px] font-semibold text-warn shadow-sm">
            Couldn&rsquo;t pinpoint this on the image — check the label by eye.
          </span>
        </div>
      )}
      <div
        ref={scrollRef}
        data-viewer-card
        onDragStart={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          if (zoom <= 1) return;
          const el = scrollRef.current;
          if (!el) return;
          e.preventDefault(); // suppress the native image-drag gesture
          drag.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
          el.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current || !scrollRef.current) return;
          scrollRef.current.scrollLeft = drag.current.sl - (e.clientX - drag.current.x);
          scrollRef.current.scrollTop = drag.current.st - (e.clientY - drag.current.y);
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        className={`label-scroll overflow-auto rounded-[10px] border border-line bg-line-soft/40 p-3 ${
          zoom > 1 ? "cursor-grab active:cursor-grabbing" : ""
        }`}
        style={{ height: viewportHeight, touchAction: zoom > 1 ? "none" : undefined }}
      >
        <div
          /* Zoomed content must not be centered by auto margins — a box wider
             than its scroll container loses its left edge that way. */
          className={`relative origin-center transition-transform duration-200 ${zoom > 1 ? "" : "mx-auto"}`}
          style={
            zoom === 1
              ? { width: "fit-content", height: "100%", transform: `rotate(${rotation}deg)` }
              : { width: `${zoom * 100}%`, transform: `rotate(${rotation}deg)` }
          }
        >
          {/* Default (100%) fits the whole label in the viewport — the brand
              must be visible without scrolling (conformance finding #4). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            alt="Submitted label"
            /* Without this the browser starts a native image drag on the
               first pointermove, which fires pointercancel and kills the
               pan gesture after a few pixels. */
            draggable={false}
            className={`select-none ${zoom === 1 ? "h-full w-auto rounded" : "w-full rounded"}`}
            style={{ WebkitUserDrag: "none" } as React.CSSProperties}
          />
          {!rotated && overlays(true)}
        </div>
      </div>
      <div className="no-print flex flex-wrap items-center gap-2">
        {ctrl("Zoom out", () => setZoom((z) => Math.max(0.5, z - 0.25)), "−", zoom <= 0.5)}
        <span className="min-w-[44px] text-center text-[12.5px] tabular-nums text-muted">{Math.round(zoom * 100)}%</span>
        {ctrl("Zoom in", () => setZoom((z) => Math.min(2.5, z + 0.25)), "+", zoom >= 2.5)}
        {ctrl("Rotate", () => setRotation((r) => (r + 90) % 360), "Rotate")}
        {ctrl("Fit", () => { setZoom(1); setRotation(0); }, "Fit")}
        {zoom > 1 && <span className="text-[12px] text-muted-2">drag the label to move</span>}
        <button
          onClick={() => setFullSize(true)}
          className="ml-auto text-[12.5px] font-semibold text-navy hover:underline"
        >
          View full size
        </button>
      </div>

      {fullSize && (
        <div
          role="dialog"
          aria-label="Label at full size"
          className="no-print fixed inset-0 z-50 flex items-start justify-center overflow-auto p-4 md:p-8"
          style={{ background: "rgba(16,35,63,0.55)" }}
          onClick={() => setFullSize(false)}
        >
          <div className="relative w-[min(92vw,520px)] shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageUrl} alt="Submitted label at full size" className="w-full rounded-lg" />
            {overlays(false)}
          </div>
        </div>
      )}
    </div>
  );
}
