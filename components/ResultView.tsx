"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CheckResult } from "@/lib/compare/index.ts";
import type { LabelExtraction } from "@/lib/vision/contract.ts";
import type { Bands, BandField } from "@/lib/vision/locate.ts";
import { CANONICAL_WARNING } from "@/lib/compare/canonical.ts";
import { CharDiff } from "./CharDiff.tsx";
import { Chip, Icon, fieldChip, FIELD_LABELS } from "./chips.tsx";
import { LabelViewer, TONE_COLORS, type Tone } from "./LabelViewer.tsx";

/** The evidence screen (mockup states 2–5): banner → comparison list ↔ label
 *  viewer with auto-highlighted issues + connector → warning panel. Issue
 *  regions render on the label automatically; clicking a row focuses it. */

const LOCATABLE = new Set(["brand_name", "class_type", "alcohol_content", "net_contents", "warning"]);

const wvPasses = (v: string) => v === "pass" || v === "pass_formatting_note";

/** One row of the warning panel; stacks cleanly in compact containers. */
function WarningRow({
  compact,
  label,
  chip,
  text,
  action,
  anchor,
}: {
  compact: boolean;
  label: string;
  chip: React.ReactNode;
  text: string;
  action?: React.ReactNode;
  anchor?: string;
}) {
  if (compact) {
    return (
      <div data-row={anchor} className="flex flex-col gap-1.5 border-b border-hairline px-4 py-3 last:border-0">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-semibold text-ink-soft">{label}</span>
          <span className="flex items-center gap-2">{chip}{action}</span>
        </div>
        <p className="text-[13.5px] leading-snug text-ink">{text}</p>
      </div>
    );
  }
  return (
    <div data-row={anchor} className="flex items-start gap-4 border-b border-hairline px-4 py-3 last:border-0">
      <span className="w-24 shrink-0 pt-0.5 text-[13px] font-semibold text-ink-soft">{label}</span>
      <span className="min-w-0 flex-1 text-[13.5px] text-ink">{text}</span>
      {/* Fixed columns so every row's chip lands on the same vertical line,
          whether or not the row carries an action button. */}
      <span className="flex w-16 shrink-0 justify-end pt-0.5">{chip}</span>
      <span className="flex w-28 shrink-0 justify-end pt-0.5">{action ?? null}</span>
    </div>
  );
}

export function ResultView({
  result,
  extraction,
  imageUrl,
  bands,
  ms,
  confirmMs,
  onPrint,
  primaryAction,
  compact = false,
  confirming = false,
  boldAuto = null,
  boldHuman = null,
  isPdf = false,
  appNumber,
}: {
  result: CheckResult;
  extraction: LabelExtraction;
  imageUrl: string;
  bands: Bands;
  ms?: number;
  /** background second-reading time, reported separately so the headline
   *  "checked in" figure stays the time to the verdict on screen */
  confirmMs?: number;
  onPrint?: () => void;
  primaryAction?: { label: string; onClick: () => void };
  /** stacked layout for narrow containers (batch detail panel) */
  compact?: boolean;
  /** the second warning reading is still in flight — provisional verdict shown */
  confirming?: boolean;
  /** multi-signal bold gate result (null/undefined = not run or pending) */
  boldAuto?: "bold" | "not_bold" | "human" | null;
  /** the agent's own bold decision — outranks the gate in this panel */
  boldHuman?: "confirmed" | "flagged" | null;
  /** the submitted file is a PDF — the viewer shows a placeholder, not <img> */
  isPdf?: boolean;
  /** optional TTB application number — shown on the printed report */
  appNumber?: string;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLElement | null>(null);
  const [connector, setConnector] = useState<{ path: string; x1: number; y1: number; x2: number; y2: number } | null>(null);

  const counts = useMemo(() => {
    let matched = 0, mismatch = 0, review = 0, notRequired = 0;
    for (const f of result.fields) {
      if (f.verdict === "match" || f.verdict === "match_formatting") matched++;
      else if (f.verdict === "possible_mismatch" || f.verdict === "absent_on_label") mismatch++;
      else if (f.verdict === "unreadable") review++;
      else notRequired++;
    }
    const warningFails = result.warning.verdict.startsWith("fail");
    const warningReview = result.warning.verdict === "unreadable";
    return { matched, mismatch, review, notRequired, warningFails, warningReview };
  }, [result]);

  // Issue fields keep their highlight on the label at all times (mockups 3-5).
  const issueTones = useMemo(() => {
    const tones: Partial<Record<BandField, Tone>> = {};
    for (const f of result.fields) {
      if (!LOCATABLE.has(f.field)) continue;
      if (f.verdict === "possible_mismatch") tones[f.field as BandField] = "bad";
      else if (f.verdict === "unreadable") tones[f.field as BandField] = "warn";
    }
    if (counts.warningFails && result.warning.verdict !== "fail_missing") tones.warning = "bad";
    else if (counts.warningReview) tones.warning = "warn";
    return tones;
  }, [result, counts]);

  const [focusedField, setFocusedField] = useState<BandField | null>(null);
  // v2 interaction spec: highlights appear ONLY on selection (row click or
  // "Show on label"), one region at a time — nothing is pre-drawn.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setFocusedField(null), [result]);

  const shownFields = useMemo(() => {
    if (!focusedField) return {};
    const tone: Tone =
      issueTones[focusedField] ?? (focusedField === "warning" ? "warn" : "ok");
    return { [focusedField]: tone } as Partial<Record<BandField, Tone>>;
  }, [issueTones, focusedField]);

  // Connector line (mockups 2-5): focused row's right edge → overlay's left
  // edge, drawn in an SVG spanning the results grid. Redrawn on scroll/resize.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    let raf = 0;
    const draw = () => {
      raf = 0;
      // The gov panel's Formatting row anchors the warning connector when no
      // warning row exists in the comparison list (prototype falls back to
      // [data-conn-row="gov-warning"] the same way).
      const row = focusedField
        ? grid.querySelector(`[data-row="${focusedField}"]`) ??
          (focusedField === "warning" ? grid.querySelector('[data-row="warning-gov"]') : null)
        : null;
      const overlay = overlayRef.current;
      const viewer = grid.querySelector("[data-viewer-card]");
      if (!row || !overlay || !viewer) { setConnector(null); return; }
      const g = grid.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      const o = overlay.getBoundingClientRect();
      const v = viewer.getBoundingClientRect();
      // The line may only enter the image CARD — never the captions below it.
      // If the highlight is scrolled out of the card, draw nothing.
      if (o.width === 0 || o.bottom < v.top + 8 || o.top > v.bottom - 8) { setConnector(null); return; }
      // v2 connector: orthogonal path with a fixed 20px stub off the row,
      // 3px endpoint dots at both ends, terminating AT THE BOX EDGE — not at
      // the viewer card border (design §Result card / Connector).
      const x1 = r.right - g.left - 2;
      const y1 = r.top - g.top + r.height / 2;
      const y2 = Math.min(Math.max(o.top - g.top + o.height / 2, v.top - g.top + 8), v.bottom - g.top - 8);
      // Stacked (box above/below the row, e.g. gov panel → viewer): route
      // around the right side into the box's RIGHT edge, per prototype mode 's'.
      const stacked = o.top >= r.bottom - 2 || o.bottom <= r.top + 2;
      if (stacked) {
        const x2 = Math.min(o.right, v.right) - g.left + 2;
        // Keep the bend inside the container — in the narrow batch panel a
        // bend past the right edge is clipped and the line vanishes.
        const bend = Math.min(Math.max(x1, x2) + 10, g.width - 3);
        setConnector({ path: `M ${x1} ${y1} L ${bend} ${y1} L ${bend} ${y2} L ${x2} ${y2}`, x1, y1, x2, y2 });
        return;
      }
      const boxLeft = Math.max(o.left, v.left);
      const x2 = boxLeft - g.left - 2;
      const stub = Math.min(20, Math.max(8, (x2 - x1) / 2));
      setConnector({ path: `M ${x1} ${y1} L ${x1 + stub} ${y1} L ${x1 + stub} ${y2} L ${x2} ${y2}`, x1, y1, x2, y2 });
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(draw); };
    schedule();
    const interval = setInterval(schedule, 300); // regions resolve async; keep endpoints fresh
    window.addEventListener("resize", schedule);
    grid.addEventListener("scroll", schedule, true);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      clearInterval(interval);
      window.removeEventListener("resize", schedule);
      grid.removeEventListener("scroll", schedule, true);
    };
  }, [focusedField]);

  const fieldTexts = useMemo(
    () => ({
      brand_name: extraction.brand_name.text,
      class_type: extraction.class_type.text,
      alcohol_content: extraction.alcohol_content.text,
      net_contents: extraction.net_contents.text,
      warning: extraction.warning.text,
    }),
    [extraction],
  );

  if (!result.is_alcohol_label) {
    return (
      <div className="rounded-xl border border-warn-line bg-warn-bg p-5">
        <p className="text-[15px] font-semibold text-warn">This doesn&apos;t look like an alcohol label.</p>
        <p className="mt-1 text-sm text-ink-soft">Check that the right file was uploaded, then try again.</p>
      </div>
    );
  }

  const issueCount = counts.mismatch + (counts.warningFails ? 1 : 0);
  // A bold glance the machine couldn't resolve is an outstanding item, so it
  // belongs in the count — a green "matches" headline that then asks for a
  // check contradicts itself (and the row's amber status in the batch table).
  const boldGlanceOwed =
    wvPasses(result.warning.verdict) && boldHuman !== "confirmed" && boldAuto !== null && boldAuto !== "bold";
  const confirmCount = counts.review + (counts.warningReview ? 1 : 0) + (boldGlanceOwed ? 1 : 0);
  const banner =
    counts.warningFails && counts.mismatch === 0
      ? {
          cls: "border-bad-line bg-bad-bg", iconCls: "bg-bad", icon: Icon.x,
          title: "Government warning fails",
          titleCls: "text-bad",
          sub: "The label's warning statement does not meet the requirement.",
        }
      : issueCount > 0
      ? {
          cls: "border-bad-line bg-bad-bg", iconCls: "bg-bad", icon: Icon.x,
          title: `${issueCount} item${issueCount === 1 ? "" : "s"} need${issueCount === 1 ? "s" : ""} review`,
          titleCls: "text-bad",
          sub: "The label does not match the application.",
        }
      : confirmCount > 0
        ? {
            cls: "border-warn-line bg-warn-bg", iconCls: "bg-warn", icon: Icon.dot,
            title: `${confirmCount} item${confirmCount === 1 ? "" : "s"} need${confirmCount === 1 ? "s" : ""} confirmation`,
            titleCls: "text-warn",
            sub: boldGlanceOwed
              ? "Every field matches and the warning wording is exact — just confirm “GOVERNMENT WARNING” looks bold on the label."
              : "The label matches, with a visual confirmation needed.",
          }
        : {
            cls: "border-ok-line bg-ok-bg", iconCls: "bg-ok", icon: Icon.check,
            title: "Label matches the application",
            titleCls: "text-ok",
            // The one thing the AI can't verify never hides behind the green
            // headline — the bold confirm is named in the verdict itself,
            // unless the measurement gate resolved it.
            sub:
              boldHuman === "confirmed"
                ? "All required fields match, the warning wording is exact, and you confirmed the bold type."
                : boldAuto === "bold"
                ? "All required fields match, the warning wording is exact, and the prefix strokes measure heavier than the warning body."
                : "All required fields match and the warning wording is exact. One last step: glance at the label to confirm “GOVERNMENT WARNING” is in bold type — the computer can't be sure of bold.",
          };

  // Resolved = the agent confirmed it, or the gate verified it. Agreeing with
  // the machine must never make the panel look worse than not touching it.
  const boldResolved = boldHuman === "confirmed" || boldAuto === "bold";
  const boldConfirmPending = wvPasses(result.warning.verdict) && !boldResolved;
  // Count chips carry their tone (conformance #5): matched green, mismatch
  // red, review/confirm amber, not-required grey.
  const countBits = [
    { text: `${counts.matched} matched`, cls: "text-green" },
    issueCount > 0 ? { text: `${issueCount} mismatch${issueCount === 1 ? "" : "es"}`, cls: "text-red font-semibold" } : null,
    confirmCount > 0 ? { text: `${confirmCount} review`, cls: "text-amber font-semibold" } : null,
    boldConfirmPending ? { text: "1 to confirm (bold)", cls: "text-amber" } : null,
    { text: `${counts.notRequired} not required`, cls: "text-muted-2" },
  ].filter(Boolean) as { text: string; cls: string }[];

  const wv = result.warning.verdict;
  const wordingRow =
    wv === "fail_wording" || wv === "fail_missing"
      ? { chip: <Chip tone="bad">FAIL</Chip>, text: result.warning.notes.find((n) => !/bold|second|single reading/i.test(n)) ?? "Warning text deviates from the required statement." }
      : wv === "unreadable"
        ? { chip: <Chip tone="warn">Review</Chip>, text: result.warning.notes[0] }
        : { chip: <Chip tone="ok">PASS</Chip>, text: "Exact required text found." };
  const formattingRow =
    wv === "fail_prefix_case"
      ? { chip: <Chip tone="bad">FAIL</Chip>, text: '"GOVERNMENT WARNING" must appear in capital letters (27 CFR 16.22(a)(2)).' }
      : boldHuman === "confirmed"
        ? { chip: <Chip tone="ok">PASS</Chip>, text: "Bold type confirmed by you." }
        : boldHuman === "flagged"
        ? { chip: <Chip tone="bad">FAIL</Chip>, text: "You flagged “GOVERNMENT WARNING:” as not bold (bold is required by 27 CFR 16.22(a)(2))." }
        : boldAuto === "bold"
        ? { chip: <Chip tone="ok">PASS</Chip>, text: "The prefix strokes measure heavier than the warning body, and the visual reading agrees. Stroke width is measured from the image, so this is strong evidence rather than proof — anything borderline, or any image too low-resolution to measure, is sent to you instead." }
        : boldAuto === "not_bold"
          ? { chip: <Chip tone="warn">Review</Chip>, text: "The stroke-width measurement says “GOVERNMENT WARNING:” may NOT be bold (required by 27 CFR 16.22(a)(2)) — check the picture." }
          : {
              chip: <Chip tone="warn">Review</Chip>,
              text:
                extraction.warning_prefix_bold === "bold"
                  ? "The computer can't be certain about bold type on this label — please confirm “GOVERNMENT WARNING:” is bold on the picture."
                  : extraction.warning_prefix_bold === "not_bold"
                    ? "The computer suggests the prefix may NOT be bold (bold is required by 27 CFR 16.22(a)(2)) — please check the picture."
                    : "The computer could not judge bold type — please check the picture.",
            };
  const bodyBoldNote = result.warning.notes.find((n) => n.startsWith("The warning body text appears"));
  const sizeNote = result.warning.notes.find((n) => /small/i.test(n) && n !== bodyBoldNote);
  const wasConfirmed = result.warning.notes.some((n) => n.startsWith("Confirmed by a second"));
  const singleReadingNote = result.warning.notes.find((n) => n.includes("from a single reading"));
  const showWarningDiff = wv === "fail_wording";

  const rowTone = (v: string): Tone =>
    v === "possible_mismatch" || v === "absent_on_label" ? "bad" : v === "unreadable" ? "warn" : "ok";

  return (
    <div
      ref={gridRef}
      data-conn-root
      className={`relative flex flex-col gap-5 ${compact ? "" : "rounded-xl border border-line bg-card p-6 md:px-7"}`}
    >
      {/* No connector in the compact panel: the viewer sits directly under the
          rows at full width, so the line would have nowhere to run but down
          the right edge, crossing the warning block on its way. The panel
          connects them by scrolling the highlight into view instead. */}
      {!compact && connector && focusedField && (
        <svg className="no-print pointer-events-none absolute inset-0 z-10 hidden h-full w-full lg:block" aria-hidden>
          <path
            d={connector.path}
            fill="none"
            stroke={TONE_COLORS[shownFields[focusedField] ?? "ok"]}
            strokeWidth="1.5"
          />
          <circle cx={connector.x1} cy={connector.y1} r="3" fill={TONE_COLORS[shownFields[focusedField] ?? "ok"]} />
          <circle cx={connector.x2} cy={connector.y2} r="3" fill={TONE_COLORS[shownFields[focusedField] ?? "ok"]} />
        </svg>
      )}
      {appNumber?.trim() && (
        <p className="hidden text-[12px] text-muted print:block">TTB application #{appNumber.trim()}</p>
      )}
      {/* Banner (v2: 30px tone circle, tone-tinted count chips, right-aligned
          time). Prototype: untinted row on the result page; tinted container
          only in the compact panel (conformance #11). */}
      <div className={`flex flex-wrap items-start gap-3 ${compact ? `rounded-[10px] border p-4 ${banner.cls}` : "py-1"}`}>
        <span className={`mt-0.5 flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full text-white ${banner.iconCls}`}>
          {banner.icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className={`text-[18px] font-bold ${banner.titleCls}`}>{banner.title}</p>
          <p className="text-[13px] text-muted">{banner.sub}</p>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px] font-medium">
            {countBits.map((b) => (
              <span key={b.text} className={`whitespace-nowrap ${b.cls}`}>{b.text}</span>
            ))}
          </p>
        </div>
        {ms !== undefined && (
          <span className="whitespace-nowrap text-[12.5px] text-muted-2">
            Checked in {(ms / 1000).toFixed(1)}s
            {confirmMs ? ` · second reading ${(confirmMs / 1000).toFixed(1)}s` : ""}
          </span>
        )}
      </div>

      <div className={`grid ${compact ? "gap-5" : "gap-5 lg:grid-cols-2 lg:gap-11"}`}>
        {/* Comparison list */}
        <section>
          <p className="mb-2 text-[11.5px] font-semibold uppercase tracking-wider text-ink-faint">Comparison</p>
          <div className="overflow-hidden rounded-xl border border-hairline bg-card">
            {result.fields.map((f) => {
              const locatable = LOCATABLE.has(f.field) && f.verdict !== "not_provided" && f.verdict !== "absent_on_label";
              const isFocused = focusedField === f.field;
              const tone = rowTone(f.verdict);
              const rowBg =
                tone === "bad" ? "bg-bad-bg/70" : tone === "warn" ? "bg-warn-bg/70" : isFocused ? "bg-ok-bg/70" : "";
              const focusRing = isFocused
                ? tone === "bad" ? "shadow-[inset_0_0_0_1.5px_#b3261e]" : tone === "warn" ? "shadow-[inset_0_0_0_1.5px_#b25e09]" : "shadow-[inset_0_0_0_1.5px_#167c3d]"
                : "";
              return (
                <button
                  key={f.field}
                  data-row={f.field}
                  disabled={!locatable}
                  onClick={() => setFocusedField(isFocused ? null : (f.field as BandField))}
                  aria-label={`${FIELD_LABELS[f.field]}: ${f.verdict.replace(/_/g, " ")}${locatable ? " — show on label" : ""}`}
                  className={`flex w-full items-center gap-3 border-b border-hairline px-4 py-3 text-left last:border-0 ${rowBg} ${focusRing} ${locatable ? "cursor-pointer hover:bg-muted-bg/70" : "cursor-default"}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-semibold text-ink-soft">{FIELD_LABELS[f.field]}</span>
                    {f.verdict === "possible_mismatch" ? (
                      // v2: mismatch value STACKS "On label:" underneath —
                      // never a second column (overlaps at narrow widths).
                      <span className="block text-[12.5px]">
                        <span className="block text-red">{f.applicationValue}</span>
                        <span className="block font-semibold text-red">On label: {f.labelValue || "—"}</span>
                      </span>
                    ) : (
                      <span className="block truncate text-[14px] text-ink">
                        {f.verdict === "not_provided" ? "Not provided" : f.applicationValue || "—"}
                      </span>
                    )}
                    {f.note && f.verdict !== "not_provided" && (
                      <span className="block text-[12px] text-ink-faint">{f.note}</span>
                    )}
                  </span>
                  {fieldChip(f.verdict)}
                  {/* Magnifier only on flaggable rows (conformance #10) —
                      matched rows stay clickable but don't advertise it. */}
                  {locatable && tone !== "ok" && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-ink-faint" aria-hidden>
                      <circle cx="11" cy="11" r="7" /><path d="M21 21l-5-5" strokeLinecap="round" />
                    </svg>
                  )}
                </button>
              );
            })}
            {(counts.warningFails || counts.warningReview) && (
              <button
                data-row="warning"
                onClick={() => setFocusedField(focusedField === "warning" ? null : "warning")}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left ${counts.warningFails ? "bg-bad-bg/70" : "bg-warn-bg/70"} ${focusedField === "warning" ? (counts.warningFails ? "shadow-[inset_0_0_0_1.5px_#b3261e]" : "shadow-[inset_0_0_0_1.5px_#b25e09]") : ""}`}
                aria-label="Government warning — show on label"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-semibold text-ink-soft">Government warning</span>
                  {/* The row states the REASON; "confirmed by second reading"
                      is corroboration, not the explanation. */}
                  <span className="block text-[13.5px] text-ink">
                    {result.warning.notes.find((n) => !/second independent|single reading/i.test(n)) ?? result.warning.notes[0]}
                  </span>
                </span>
                {counts.warningFails ? <Chip tone="bad">{Icon.x} Fail</Chip> : <Chip tone="warn">Review</Chip>}
              </button>
            )}
          </div>
        </section>

        {/* Label viewer */}
        <section>
          <p className="mb-2 text-[11.5px] font-semibold uppercase tracking-wider text-ink-faint">Submitted label</p>
          <LabelViewer
            imageUrl={imageUrl}
            isPdf={isPdf}
            fieldTexts={fieldTexts}
            bands={bands}
            shownFields={shownFields}
            focusedField={focusedField}
            connectorRef={overlayRef}
            viewportHeight={compact ? 300 : 340}
          />
          <p className="mt-1.5 text-[12px] text-ink-faint">
            Click a row (or “Show on label”) to see where it sits on the label. Locations are found automatically and may be approximate.
          </p>
        </section>
      </div>

      {/* Government warning panel. In compact containers each row stacks —
          label + chip on top, sentence below — instead of four columns
          fighting over 400px. */}
      <section className="rounded-xl border border-hairline bg-card">
        <p className="border-b border-hairline px-4 py-2.5 text-[11.5px] font-semibold uppercase tracking-wider text-ink-faint">
          Government warning
        </p>
        <WarningRow compact={compact} label="Wording" chip={wordingRow.chip} text={wordingRow.text} />
        <WarningRow
          compact={compact}
          label="Formatting"
          anchor="warning-gov"
          chip={formattingRow.chip}
          text={formattingRow.text}
          action={
            <button
              onClick={() => setFocusedField(focusedField === "warning" ? null : "warning")}
              className="no-print whitespace-nowrap rounded-lg border border-hairline px-2.5 py-1 text-[12px] font-semibold text-ink-soft hover:bg-muted-bg"
            >
              Show on label
            </button>
          }
        />
        {bodyBoldNote && (
          <WarningRow compact={compact} label="Body type" chip={<Chip tone="warn">Review</Chip>} text={bodyBoldNote} />
        )}
        {sizeNote && (
          <WarningRow compact={compact} label="Size" chip={<Chip tone="warn">Review</Chip>} text={sizeNote} />
        )}
        {confirming && (
          <p className="flex items-center gap-2 border-t border-hairline px-4 py-2.5 text-[12px] font-semibold text-amber">
            <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-amber border-t-transparent" aria-hidden />
            <span className="animate-pulse">Double-checking this with a second reading — this may take a few seconds…</span>
          </p>
        )}
        {!confirming && wasConfirmed && (
          <p className="border-t border-hairline px-4 py-2.5 text-[12px] text-ink-faint">
            ✓ Double-checked — a second reading of the label found the same thing.
          </p>
        )}
        {!confirming && singleReadingNote && (
          <p className="border-t border-hairline px-4 py-2.5 text-[12px] font-semibold text-amber">{singleReadingNote}</p>
        )}
        {showWarningDiff && result.warning.labelText && (
          <div className="border-t border-hairline px-4 py-3">
            <p className="mb-1 text-[12px] text-ink-faint">
              <del className="rounded-sm bg-bad-bg px-0.5 text-bad line-through">Crossed out</del> = what the required text says ·{" "}
              <ins className="rounded-sm border-b-2 border-ok bg-ok-bg px-0.5 text-ok no-underline">underlined</ins> = what the label actually prints
            </p>
            <CharDiff expected={CANONICAL_WARNING} actual={result.warning.labelText} />
          </div>
        )}
      </section>

      {(onPrint || primaryAction) && (
        <div className="no-print flex flex-wrap items-center justify-between gap-3">
          {onPrint ? (
            <span className="flex items-center gap-3">
              <button
                onClick={onPrint}
                className="flex items-center gap-2 rounded-xl border border-hairline bg-card px-4 py-2.5 text-[14px] font-semibold text-ink-soft hover:bg-muted-bg"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2m-12-3h12v6H6z" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Print report
              </button>
              <span className="text-[12px] text-ink-faint">choose “Save as PDF” in the print window for a file</span>
            </span>
          ) : <span />}
          {primaryAction && (
            <button
              onClick={primaryAction.onClick}
              className="flex items-center gap-2 rounded-xl bg-navy px-6 py-3 text-[15px] font-bold text-white shadow-sm transition hover:bg-navy-hover"
            >
              {primaryAction.label}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
                <path d="M4 12h15m0 0l-6-6m6 6l-6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
