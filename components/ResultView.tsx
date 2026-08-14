"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CheckResult } from "@/lib/compare/index.ts";
import type { LabelExtraction } from "@/lib/vision/contract.ts";
import type { Bands, BandField } from "@/lib/vision/locate.ts";
import { CANONICAL_WARNING } from "@/lib/compare/canonical.ts";
import { summarizeVerdict, type FieldDecision } from "@/lib/verdict.ts";
import { CharDiff } from "./CharDiff.tsx";
import { Chip, Icon, fieldChip, FIELD_LABELS } from "./chips.tsx";
import { LabelViewer, TONE_COLORS, type Tone } from "./LabelViewer.tsx";

/** The evidence screen (mockup states 2–5): banner → comparison list ↔ label
 *  viewer with auto-highlighted issues + connector → warning panel. Issue
 *  regions render on the label automatically; clicking a row focuses it. */

const LOCATABLE = new Set(["brand_name", "class_type", "alcohol_content", "net_contents", "warning"]);

const wvPasses = (v: string) => v === "pass" || v === "pass_formatting_note";

/** Re-exported so the components that render decisions keep one import. */
export type { FieldDecision };

const isRedVerdict = (v: string) => v === "possible_mismatch" || v === "absent_on_label";

/** Decision controls.
 *
 *  These sit in a fixed right-hand column, aligned across rows, because the
 *  eye reads field → value → status → action and a control parked under the
 *  sentence gets missed. They carry colour and weight for the same reason:
 *  ghost-grey buttons on an already-tinted row disappear into it. */
const DECIDE_BASE =
  "flex h-[30px] w-full items-center justify-center gap-1 rounded-[7px] border-[1.5px] px-2 text-[12px] font-bold transition";
const DECIDE_ACCEPT_IDLE =
  "border-ok-line bg-card text-ok hover:bg-ok-bg";
const DECIDE_ACCEPT_ON = "border-ok bg-ok text-white";
const DECIDE_REJECT_IDLE =
  "border-bad-line bg-card text-bad hover:bg-bad-bg";
const DECIDE_REJECT_ON = "border-bad bg-bad text-white";

const TICK = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" aria-hidden>
    <path d="M4 12l5 5L20 6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const CROSS = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" aria-hidden>
    <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
  </svg>
);

/** The two-button decision control used by every surface that records one —
 *  flagged comparison rows, the bold glance, and the batch panel's ruling on
 *  the whole label. One control, one pair of words, everywhere a decision is
 *  made, so nobody has to learn a second vocabulary in the batch view. */
export function DecidePair({
  value,
  onChange,
  acceptLabel,
  rejectLabel,
  ariaPrefix,
  orientation = "stacked",
}: {
  value: "accept" | "reject" | null;
  onChange: (v: "accept" | "reject" | null) => void;
  acceptLabel: string;
  rejectLabel: string;
  ariaPrefix: string;
  /** "row" for wide containers (the batch panel footer) */
  orientation?: "stacked" | "row";
}) {
  return (
    <span className={`no-print flex w-full gap-1.5 ${orientation === "row" ? "flex-row" : "flex-col"}`}>
      <button
        onClick={(e) => { e.stopPropagation(); onChange(value === "accept" ? null : "accept"); }}
        aria-pressed={value === "accept"}
        aria-label={`${ariaPrefix}: ${acceptLabel}`}
        className={`${DECIDE_BASE} ${value === "accept" ? DECIDE_ACCEPT_ON : DECIDE_ACCEPT_IDLE}`}
      >
        {TICK}{acceptLabel}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onChange(value === "reject" ? null : "reject"); }}
        aria-pressed={value === "reject"}
        aria-label={`${ariaPrefix}: ${rejectLabel}`}
        className={`${DECIDE_BASE} ${value === "reject" ? DECIDE_REJECT_ON : DECIDE_REJECT_IDLE}`}
      >
        {CROSS}{rejectLabel}
      </button>
    </span>
  );
}

/** One row of the warning panel; stacks cleanly in compact containers.
 *
 *  A row that can be located on the label is itself the click target, exactly
 *  like the comparison rows — one gesture for one job. It used to carry a
 *  separate "Show on label" button, which meant the same action wore two
 *  different affordances on one screen and the caption had to explain both.
 *  The whole row responds, via a handler on the container that ignores clicks
 *  originating in a real control; the inner button remains for semantics,
 *  keyboard and the accessible name. The decision controls therefore stay
 *  OUTSIDE that button, because real buttons must not nest inside another
 *  button (508). */
function WarningRow({
  compact,
  label,
  chip,
  text,
  anchor,
  extra,
  onSelect,
}: {
  compact: boolean;
  label: string;
  chip: React.ReactNode;
  text: string;
  anchor?: string;
  /** optional decision controls rendered under the sentence (e.g. the bold
   *  confirm pills) — kept out of the click target */
  extra?: React.ReactNode;
  /** present = clicking the row shows this row's subject on the label */
  onSelect?: () => void;
}) {
  // Clicks from a real control (this row's own button, or the decision pair in
  // `extra`) are handled by that control; anything else in the row counts.
  const rowClick = onSelect
    ? (e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest("button")) return;
        onSelect();
      }
    : undefined;
  if (compact) {
    const Target = onSelect ? "button" : "div";
    return (
      <div
        data-row={anchor}
        onClick={rowClick}
        className={`flex flex-col gap-1.5 border-b border-hairline px-4 py-3 last:border-0 ${onSelect ? "cursor-pointer" : ""}`}
      >
        <Target
          onClick={onSelect}
          aria-label={onSelect ? `${label} — show on label` : undefined}
          className="flex w-full flex-col gap-1.5 text-left"
        >
          <span className="flex items-center justify-between gap-3">
            <span className="text-[13px] font-semibold text-ink-soft">{label}</span>
            {chip}
          </span>
          <span className="text-[13.5px] leading-snug text-ink">{text}</span>
        </Target>
        {extra}
      </div>
    );
  }
  const Target = onSelect ? "button" : "span";
  return (
    <div
      data-row={anchor}
      onClick={rowClick}
      className={`flex items-start gap-4 border-b border-hairline px-4 py-3 last:border-0 ${onSelect ? "cursor-pointer" : ""}`}
    >
      <Target
        onClick={onSelect}
        aria-label={onSelect ? `${label} — show on label` : undefined}
        className="flex min-w-0 flex-1 items-start gap-4 text-left"
      >
        <span className="w-24 shrink-0 pt-0.5 text-[13px] font-semibold text-ink-soft">{label}</span>
        <span className="min-w-0 flex-1 text-[13.5px] text-ink">{text}</span>
      </Target>
      {/* Fixed columns so every row's chip lands on the same vertical line,
          whether or not the row carries a decision control. */}
      <span className="flex w-16 shrink-0 justify-end pt-0.5">{chip}</span>
      <span className="flex w-[104px] shrink-0 flex-col items-end gap-1.5 pt-0.5">{extra}</span>
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
  boldMeasuring = false,
  bandsPending = false,
  isPdf = false,
  auditTrail,
  appNumber,
  fieldReview,
  onFieldReview,
  onBoldReview,
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
  /** the gate is still measuring: the glance is not owed YET, so the headline
   *  says "checking" instead of flickering through "1 to confirm" and back */
  boldMeasuring?: boolean;
  /** The locator has not been asked yet — the batch panel fetches bands lazily
   *  when a row opens. Without this the viewer announced "couldn't pinpoint the
   *  government warning" the instant a row was opened and corrected itself a
   *  few seconds later: claiming a failure before looking, which is the same
   *  dishonesty the bold gate's "measuring" state exists to prevent. */
  bandsPending?: boolean;
  /** the submitted file is a PDF — the viewer shows a placeholder, not <img> */
  isPdf?: boolean;
  /** optional TTB application number — shown on the printed report */
  appNumber?: string;
  /** Rendered inside the card, just above the action row. The single-check
   *  page used to render its audit trail AFTER this component, which put it
   *  below "Check another label" and outside the card entirely — far enough
   *  out of the main window that it read as missing. */
  auditTrail?: React.ReactNode;
  /** the agent's per-field rulings — layered over the machine verdicts */
  fieldReview?: Partial<Record<string, FieldDecision>>;
  /** present = flagged rows grow Accept / Confirm pills (null clears) */
  onFieldReview?: (field: string, d: FieldDecision | null) => void;
  /** present = the bold glance can be decided right here (null clears) */
  onBoldReview?: (d: "confirmed" | "flagged" | null) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLElement | null>(null);
  const [connector, setConnector] = useState<{ path: string; x1: number; y1: number; x2: number; y2: number } | null>(null);

  // ONE tally, shared with the stepper in the top bar and the batch status
  // pill (lib/verdict.ts) so no two surfaces can describe the same label
  // differently.
  const counts = useMemo(
    () => summarizeVerdict(result, fieldReview, { auto: boldAuto, human: boldHuman, measuring: boldMeasuring }, confirming),
    [result, fieldReview, boldAuto, boldHuman, boldMeasuring, confirming],
  );

  // Issue fields keep their highlight on the label at all times (mockups 3-5).
  const issueTones = useMemo(() => {
    const tones: Partial<Record<BandField, Tone>> = {};
    for (const f of result.fields) {
      if (!LOCATABLE.has(f.field)) continue;
      if (f.verdict === "possible_mismatch")
        tones[f.field as BandField] = fieldReview?.[f.field] === "accepted" ? "ok" : "bad";
      else if (f.verdict === "unreadable") tones[f.field as BandField] = "warn";
    }
    // A rejected bold type is a failure of the warning, so the region on the
    // label reads red — the same colour the Formatting row now carries.
    if ((counts.warningFails && result.warning.verdict !== "fail_missing") || counts.bold === "rejected")
      tones.warning = "bad";
    else if (counts.warningReview || counts.bold === "owed") tones.warning = "warn";
    return tones;
  }, [result, counts, fieldReview]);

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

  // Where to look when the locator never found the warning. Measured cause:
  // for a shadowed label the locator returns bands for every field EXCEPT the
  // warning, and the OCR repair cannot find it either — so focusing the
  // warning row drew nothing at all while the row still said "click me". The
  // mandated statement sits at the foot of the label on essentially every
  // submission, so the viewer shows that, captioned as a guess. Same honesty
  // the batch spot-check card already carries.
  const WARNING_FALLBACK_BAND: [number, number] = [700, 1000];
  const warningLocated = Boolean(bands.warning);
  // Still looking: the batch panel has not fetched bands yet, or the single
  // page's OCR repair is still running and may yet supply one. Guess only once
  // the search has actually finished and come up empty.
  const warningSearchPending = bandsPending || (boldMeasuring && !warningLocated);
  const guessWarningLocation = !warningLocated && !warningSearchPending;
  const viewerBands = useMemo(
    () => (guessWarningLocation ? { ...bands, warning: WARNING_FALLBACK_BAND } : bands),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bands, guessWarningLocation],
  );
  const guessingWarningLocation = guessWarningLocation && focusedField === "warning";

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

  // Banner dressing for the shared verdict. Count chips carry their tone
  // (conformance #5): matched green, mismatch red, review/confirm amber,
  // not-required grey — and every one of them is built in lib/verdict.ts, so
  // the chips can't contradict the headline above them.
  const banner =
    counts.tone === "bad"
      ? { cls: "border-bad-line bg-bad-bg", iconCls: "bg-bad", icon: Icon.x, titleCls: "text-bad" }
      : counts.tone === "warn"
        ? { cls: "border-warn-line bg-warn-bg", iconCls: "bg-warn", icon: Icon.dot, titleCls: "text-warn" }
        : { cls: "border-ok-line bg-ok-bg", iconCls: "bg-ok", icon: Icon.check, titleCls: "text-ok" };
  const countBits = counts.chips;

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
        ? { chip: <Chip tone="ok">PASS</Chip>, text: "You accepted the bold type." }
        : boldHuman === "flagged"
        ? { chip: <Chip tone="bad">FAIL</Chip>, text: "You rejected the bold type — “GOVERNMENT WARNING:” is not bold (required by 27 CFR 16.22(a)(2))." }
        : boldMeasuring && boldAuto === null
        ? { chip: <Chip tone="muted">Checking</Chip>, text: "Measuring the stroke width of “GOVERNMENT WARNING:” against the warning body — one moment." }
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

  // The warning panel is a section, not a row, so when it is the selected
  // thing the WHOLE section carries the tint + ring that a selected comparison
  // row carries. Before this it was the only click target on the screen that
  // gave no sign it had been clicked — the connector drew out to the image
  // while the thing you just acted on sat there looking untouched. The tone
  // matches the box drawn on the label (see shownFields).
  const warningFocused = focusedField === "warning";
  const warningTone: Tone = issueTones.warning ?? "warn";
  // Full-strength tint tokens, not new /40 opacity variants: the tints are
  // already near-white (#fdf6e7), and every one of these classes is used
  // elsewhere, so the panel can't end up untinted because a fresh utility
  // failed to generate.
  const warningPanelCls = !warningFocused
    ? "border-hairline bg-card"
    : warningTone === "bad"
      ? "border-bad-line bg-bad-bg shadow-[inset_0_0_0_1.5px_#b3261e]"
      : warningTone === "warn"
        ? "border-warn-line bg-warn-bg shadow-[inset_0_0_0_1.5px_#b25e09]"
        : "border-ok-line bg-ok-bg shadow-[inset_0_0_0_1.5px_#167c3d]";

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
          <p className={`text-[18px] font-bold ${banner.titleCls}`}>{counts.title}</p>
          <p className="text-[13px] text-muted">{counts.sub}</p>
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
              const red = isRedVerdict(f.verdict);
              const decision = red ? fieldReview?.[f.field] ?? null : null;
              // An accepted row reads resolved (green) — the machine's flag
              // stays visible in the note line, never in the row's tone.
              const tone = decision === "accepted" ? "ok" : rowTone(f.verdict);
              const valueCls = decision === "accepted" ? "text-ink" : "text-red";
              const rowBg =
                tone === "bad" ? "bg-bad-bg/70" : tone === "warn" ? "bg-warn-bg/70" : isFocused ? "bg-ok-bg/70" : decision === "accepted" ? "bg-ok-bg/40" : "";
              const focusRing = isFocused
                ? tone === "bad" ? "shadow-[inset_0_0_0_1.5px_#b3261e]" : tone === "warn" ? "shadow-[inset_0_0_0_1.5px_#b25e09]" : "shadow-[inset_0_0_0_1.5px_#167c3d]"
                : "";
              // Every locatable row is a click target and nothing else says so
              // (the magnifier used to say it on flagged rows only, so on a
              // clean match — every row matched — it appeared nowhere at all
              // while the caption still told people to click). An inset ring
              // on hover reads through the tinted backgrounds that a hover
              // background colour would fight with.
              const hoverRing = locatable && !isFocused ? "transition hover:shadow-[inset_0_0_0_1.5px_#c3cad3]" : "";
              const chip =
                decision === "accepted" ? <Chip tone="ok">{Icon.check} Accepted</Chip>
                  : decision === "confirmed" ? <Chip tone="bad">{Icon.x} Rejected</Chip>
                  : fieldChip(f.verdict);
              const decidable = red && onFieldReview;
              return (
                <div
                  key={f.field}
                  data-row={f.field}
                  // The WHOLE row is the click target, not just its text. The
                  // inner button stays for semantics, keyboard and the
                  // accessible name — it simply no longer has to be the only
                  // way in. Clicks that came from a real control are ignored
                  // here so the row's own button and the Accept / Reject pair
                  // handle their own presses and nothing double-fires; a real
                  // button cannot be nested inside another button (508), which
                  // is why this is a container handler rather than one big
                  // stretched button.
                  onClick={
                    locatable
                      ? (e) => {
                          if ((e.target as HTMLElement).closest("button")) return;
                          setFocusedField(isFocused ? null : (f.field as BandField));
                        }
                      : undefined
                  }
                  className={`flex items-start gap-3 border-b border-hairline px-4 py-3 last:border-0 ${
                    locatable ? "cursor-pointer" : ""
                  } ${rowBg} ${focusRing} ${hoverRing}`}
                >
                <button
                  disabled={!locatable}
                  onClick={() => setFocusedField(isFocused ? null : (f.field as BandField))}
                  aria-label={`${FIELD_LABELS[f.field]}: ${f.verdict.replace(/_/g, " ")}${locatable ? " — show on label" : ""}`}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-semibold text-ink-soft">{FIELD_LABELS[f.field]}</span>
                    {f.verdict === "possible_mismatch" ? (
                      // v2: mismatch value STACKS "On label:" underneath —
                      // never a second column (overlaps at narrow widths).
                      <span className="block text-[12.5px]">
                        <span className={`block ${valueCls}`}>{f.applicationValue}</span>
                        <span className={`block font-semibold ${valueCls}`}>On label: {f.labelValue || "—"}</span>
                      </span>
                    ) : (
                      <span className="block truncate text-[14px] text-ink">
                        {f.verdict === "not_provided" ? "Not provided" : f.applicationValue || "—"}
                      </span>
                    )}
                    {f.note && f.verdict !== "not_provided" && (
                      <span className="block text-[12px] text-ink-faint">{f.note}</span>
                    )}
                    {/* The ruling never hides the machine's finding — the
                        record of who decided what stays on the row (and on
                        the printed report). */}
                    {decision && (
                      <span className="block text-[12px] italic text-ink-faint">
                        {decision === "accepted"
                          ? "The computer flagged this — you reviewed it and accepted the label."
                          : "You rejected this — a real mismatch."}
                      </span>
                    )}
                  </span>
                </button>
                {/* Status, then decision — a fixed right column so the
                    controls line up across rows and scan vertically. */}
                <span className="flex shrink-0 justify-end pt-0.5">{chip}</span>
                {decidable && (
                  <span className="w-[104px] shrink-0">
                    <DecidePair
                      value={decision === "accepted" ? "accept" : decision === "confirmed" ? "reject" : null}
                      onChange={(v) =>
                        onFieldReview(f.field, v === "accept" ? "accepted" : v === "reject" ? "confirmed" : null)
                      }
                      acceptLabel="Accept"
                      rejectLabel="Reject"
                      ariaPrefix={FIELD_LABELS[f.field]}
                    />
                  </span>
                )}
                </div>
              );
            })}
            {/* The government warning is ALWAYS listed here, whatever its
                verdict. It used to appear only when it failed or could not be
                read, so the same subject showed up in one place or two
                depending on the outcome — an owner comparing two samples
                noticed immediately and had to work out why. It is the one
                check with a hard fail, so it belongs in the list a person
                scans, passing or not; the panel below stays the place its two
                halves (wording, formatting) are split out. */}
            {(() => {
              const failed = counts.warningFails || counts.bold === "rejected";
              const review = !failed && (counts.warningReview || counts.bold === "owed");
              const tint = failed ? "bg-bad-bg/70" : review ? "bg-warn-bg/70" : "";
              const ring = focusedField === "warning"
                ? failed ? "shadow-[inset_0_0_0_1.5px_#b3261e]"
                  : review ? "shadow-[inset_0_0_0_1.5px_#b25e09]"
                  : "shadow-[inset_0_0_0_1.5px_#167c3d]"
                : "";
              // A passing warning has no note to quote, so say the thing the
              // panel says rather than leaving the row blank.
              const note = result.warning.notes.find((n) => !/second independent|single reading/i.test(n))
                ?? result.warning.notes[0];
              const text = failed || review
                ? note ?? "Check the warning on the label."
                : counts.bold === "rejected"
                  ? "You rejected the bold type."
                  : "Exact required text found.";
              return (
                <button
                  data-row="warning"
                  onClick={() => setFocusedField(focusedField === "warning" ? null : "warning")}
                  className={`flex w-full items-center gap-3 border-t border-hairline px-4 py-3 text-left ${tint} ${ring}`}
                  aria-label="Government warning — show on label"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-semibold text-ink-soft">Government warning</span>
                    <span className="block text-[13.5px] text-ink">{text}</span>
                  </span>
                  {failed ? <Chip tone="bad">{Icon.x} Fail</Chip>
                    : review ? <Chip tone="warn">Review</Chip>
                    : <Chip tone="ok">{Icon.check} Pass</Chip>}
                </button>
              );
            })()}
          </div>
        </section>

        {/* Label viewer */}
        <section>
          <p className="mb-2 text-[11.5px] font-semibold uppercase tracking-wider text-ink-faint">Submitted label</p>
          <LabelViewer
            imageUrl={imageUrl}
            isPdf={isPdf}
            fieldTexts={fieldTexts}
            bands={viewerBands}
            shownFields={shownFields}
            focusedField={focusedField}
            connectorRef={overlayRef}
            viewportHeight={compact ? 300 : 340}
          />
          <p className="mt-1.5 text-[12px] text-ink-faint">
            {/* This once read "click the wording", because the target really
                was only the text — measured at 73-75% of the row width, so
                someone clicking the right-hand end got nothing. The row itself
                is the target now, and the caption can go back to saying the
                simple thing. */}
            {guessingWarningLocation
              ? "Couldn’t pinpoint the government warning on this image — showing the foot of the label, where it normally sits."
              : "Click any row to see where it sits on the label. Locations are found automatically and may be approximate."}
          </p>
        </section>
      </div>

      {/* Government warning panel. In compact containers each row stacks —
          label + chip on top, sentence below — instead of four columns
          fighting over 400px. */}
      <section className={`rounded-xl border transition-colors ${warningPanelCls}`}>
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
          onSelect={() => setFocusedField(focusedField === "warning" ? null : "warning")}
          extra={
            // The bold decision uses the same control, in the same column,
            // with the same two words as the comparison rows. Hidden while the
            // gate is still measuring — asking for a glance the machine is
            // about to resolve is how the batch panel ended up with two sets
            // of bold buttons in two different places.
            onBoldReview && wvPasses(wv) && !(boldMeasuring && boldAuto === null) &&
            (boldHuman !== null || boldAuto !== "bold") ? (
              <DecidePair
                value={boldHuman === "confirmed" ? "accept" : boldHuman === "flagged" ? "reject" : null}
                onChange={(v) =>
                  onBoldReview(v === "accept" ? "confirmed" : v === "reject" ? "flagged" : null)
                }
                acceptLabel="Accept"
                rejectLabel="Reject"
                ariaPrefix="Government warning bold type"
              />
            ) : undefined
          }
        />
        {bodyBoldNote && (
          <WarningRow compact={compact} label="Body type" chip={<Chip tone="warn">Review</Chip>} text={bodyBoldNote} />
        )}
        {sizeNote && (
          // Not a "Review" chip: type size legally cannot be settled from an
          // image (16.22(b) is a physical measurement), so an agent can never
          // clear this row. Dressing an unclearable caveat as review work
          // teaches people to ignore the amber chips that DO need them. It
          // stays visible, as a note.
          <WarningRow compact={compact} label="Size" chip={<Chip tone="muted">{Icon.dot} Note</Chip>} text={sizeNote} />
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

      {auditTrail}

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
