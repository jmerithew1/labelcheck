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
}: {
  compact: boolean;
  label: string;
  chip: React.ReactNode;
  text: string;
  action?: React.ReactNode;
}) {
  if (compact) {
    return (
      <div className="flex flex-col gap-1.5 border-b border-hairline px-4 py-3 last:border-0">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-semibold text-ink-soft">{label}</span>
          <span className="flex items-center gap-2">{chip}{action}</span>
        </div>
        <p className="text-[13.5px] leading-snug text-ink">{text}</p>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-4 border-b border-hairline px-4 py-3 last:border-0">
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
  onPrint,
  primaryAction,
  compact = false,
  appNumber,
}: {
  result: CheckResult;
  extraction: LabelExtraction;
  imageUrl: string;
  bands: Bands;
  ms?: number;
  onPrint?: () => void;
  primaryAction?: { label: string; onClick: () => void };
  /** stacked layout for narrow containers (batch detail panel) */
  compact?: boolean;
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

  const firstIssue = (Object.keys(issueTones) as BandField[])[0] ?? null;
  const [focusedField, setFocusedField] = useState<BandField | null>(firstIssue);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setFocusedField(firstIssue), [result]);

  const shownFields = useMemo(() => {
    const shown = { ...issueTones };
    // A focused "confirm this" item (the bold check) highlights amber, not the
    // green of a verified match — green would say "fine" about the one thing
    // being double-checked.
    if (focusedField && !shown[focusedField]) {
      shown[focusedField] = focusedField === "warning" ? "warn" : "ok";
    }
    return shown;
  }, [issueTones, focusedField]);

  // Connector line (mockups 2-5): focused row's right edge → overlay's left
  // edge, drawn in an SVG spanning the results grid. Redrawn on scroll/resize.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    let raf = 0;
    const draw = () => {
      raf = 0;
      const row = focusedField ? grid.querySelector(`[data-row="${focusedField}"]`) : null;
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
      // 3px endpoint dots at both ends (design §Result card / Connector).
      const x1 = r.right - g.left - 2;
      const y1 = r.top - g.top + r.height / 2;
      const x2 = v.left - g.left - 3;
      const y2 = Math.min(Math.max(o.top - g.top + o.height / 2, v.top - g.top + 8), v.bottom - g.top - 8);
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
  const confirmCount = counts.review + (counts.warningReview ? 1 : 0);
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
            sub: "The label matches, with a visual confirmation needed.",
          }
        : {
            cls: "border-ok-line bg-ok-bg", iconCls: "bg-ok", icon: Icon.check,
            title: "Label matches the application",
            titleCls: "text-ok",
            // The one thing the AI can't verify never hides behind the green
            // headline — the bold confirm is named in the verdict itself.
            sub: "All required fields match and the warning wording is exact. One last step: glance at the label to confirm “GOVERNMENT WARNING” is in bold type — the computer can't be sure of bold.",
          };

  const boldConfirmPending = wvPasses(result.warning.verdict);
  const countBits = [
    `${counts.matched} matched`,
    issueCount > 0 ? `${issueCount} mismatch${issueCount === 1 ? "" : "es"}` : null,
    confirmCount > 0 ? `${confirmCount} review` : null,
    boldConfirmPending ? "1 to confirm (bold)" : null,
    `${counts.notRequired} not required`,
  ].filter(Boolean);

  const wv = result.warning.verdict;
  const wordingRow =
    wv === "fail_wording" || wv === "fail_missing"
      ? { chip: <Chip tone="bad">FAIL</Chip>, text: result.warning.notes.find((n) => !/bold|second/i.test(n)) ?? "Warning text deviates from the required statement." }
      : wv === "unreadable"
        ? { chip: <Chip tone="warn">Review</Chip>, text: result.warning.notes[0] }
        : { chip: <Chip tone="ok">PASS</Chip>, text: "Exact required text found." };
  const formattingRow =
    wv === "fail_prefix_case"
      ? { chip: <Chip tone="bad">FAIL</Chip>, text: '"GOVERNMENT WARNING" must appear in capital letters (27 CFR 16.22(a)(2)).' }
      : {
          chip: <Chip tone="warn">Review</Chip>,
          text:
            extraction.warning_prefix_bold === "bold"
              ? "The computer can't reliably judge bold type (right on 16 of 17 test labels) — please confirm “GOVERNMENT WARNING:” is bold on the picture."
              : extraction.warning_prefix_bold === "not_bold"
                ? "The computer suggests the prefix may NOT be bold (bold is required by 27 CFR 16.22(a)(2)) — please check the picture."
                : "The computer could not judge bold type — please check the picture.",
        };
  const sizeNote = result.warning.notes.find((n) => /small/i.test(n));
  const showWarningDiff = wv === "fail_wording";

  const rowTone = (v: string): Tone =>
    v === "possible_mismatch" || v === "absent_on_label" ? "bad" : v === "unreadable" ? "warn" : "ok";

  return (
    <div className={`flex flex-col gap-5 ${compact ? "" : "rounded-xl border border-line bg-card p-6 md:px-7"}`}>
      {appNumber?.trim() && (
        <p className="hidden text-[12px] text-muted print:block">TTB application #{appNumber.trim()}</p>
      )}
      {/* Banner (v2: 30px tone circle, nowrap count chips, right-aligned time) */}
      <div className={`flex flex-wrap items-start gap-3 rounded-[10px] border p-4 ${banner.cls}`}>
        <span className={`mt-0.5 flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full text-white ${banner.iconCls}`}>
          {banner.icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className={`text-[18px] font-bold ${banner.titleCls}`}>{banner.title}</p>
          <p className="text-[13px] text-muted">{banner.sub}</p>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px] font-medium text-muted">
            {countBits.map((b) => (
              <span key={b} className="whitespace-nowrap">{b}</span>
            ))}
          </p>
        </div>
        {ms !== undefined && (
          <span className="whitespace-nowrap text-[12.5px] text-muted-2">Checked in {(ms / 1000).toFixed(1)}s</span>
        )}
      </div>

      <div ref={gridRef} data-conn-root className={`relative grid ${compact ? "gap-5" : "gap-5 lg:grid-cols-2 lg:gap-11"}`}>
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
                  {locatable && (
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
                    {result.warning.notes.find((n) => !/second independent/i.test(n)) ?? result.warning.notes[0]}
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
            fieldTexts={fieldTexts}
            bands={bands}
            shownFields={shownFields}
            focusedField={focusedField}
            connectorRef={overlayRef}
            viewportHeight={compact ? 300 : 340}
          />
          <p className="mt-1.5 text-[12px] text-ink-faint">
            Issues are highlighted on the label automatically; click a row to focus it. Locations are found automatically and may be approximate.
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
        {sizeNote && (
          <WarningRow compact={compact} label="Size" chip={<Chip tone="warn">Review</Chip>} text={sizeNote} />
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
