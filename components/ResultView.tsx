"use client";

import { useMemo, useState } from "react";
import type { CheckResult } from "@/lib/compare/index.ts";
import type { LabelExtraction } from "@/lib/vision/contract.ts";
import type { Bands, BandField } from "@/lib/vision/locate.ts";
import { CANONICAL_WARNING } from "@/lib/compare/canonical.ts";
import { CharDiff } from "./CharDiff.tsx";
import { Chip, Icon, fieldChip, FIELD_LABELS } from "./chips.tsx";
import { LabelViewer } from "./LabelViewer.tsx";

/** The evidence screen: banner → comparison list ↔ label viewer → warning
 *  panel. Shared by single check and the batch detail panel. */

const LOCATABLE = new Set(["brand_name", "class_type", "alcohol_content", "net_contents", "warning"]);

export function ResultView({
  result,
  extraction,
  imageUrl,
  bands,
  ms,
  onPrint,
}: {
  result: CheckResult;
  extraction: LabelExtraction;
  imageUrl: string;
  bands: Bands;
  ms?: number;
  onPrint?: () => void;
}) {
  const [activeField, setActiveField] = useState<BandField | null>(null);

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
    issueCount > 0
      ? {
          cls: "border-bad-line bg-bad-bg",
          iconCls: "bg-bad",
          icon: Icon.x,
          title: `${issueCount} item${issueCount === 1 ? "" : "s"} need${issueCount === 1 ? "s" : ""} review`,
          titleCls: "text-bad",
          sub: "The label does not match the application.",
        }
      : confirmCount > 0
        ? {
            cls: "border-warn-line bg-warn-bg",
            iconCls: "bg-warn",
            icon: Icon.dot,
            title: `${confirmCount} item${confirmCount === 1 ? "" : "s"} need${confirmCount === 1 ? "s" : ""} confirmation`,
            titleCls: "text-warn",
            sub: "The label matches, with a visual confirmation needed.",
          }
        : {
            cls: "border-ok-line bg-ok-bg",
            iconCls: "bg-ok",
            icon: Icon.check,
            title: "Label matches the application",
            titleCls: "text-ok",
            sub: "All required fields match. The government warning text also passed.",
          };

  const countBits = [
    `${counts.matched} matched`,
    counts.mismatch + (counts.warningFails ? 1 : 0) > 0 ? `${counts.mismatch + (counts.warningFails ? 1 : 0)} mismatch${counts.mismatch + (counts.warningFails ? 1 : 0) === 1 ? "" : "es"}` : null,
    confirmCount > 0 ? `${confirmCount} review` : null,
    `${counts.notRequired} not required`,
  ].filter(Boolean);

  const rowTone = (v: string) =>
    v === "possible_mismatch" || v === "absent_on_label" ? "bad" : v === "unreadable" ? "warn" : "ok";

  // Warning panel rows: Wording (deterministic text check) + Formatting
  // (capitals + bold) + optional size advisory.
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
              ? "Confirm “GOVERNMENT WARNING:” is bold — AI-judged only (right on 16 of 17 test labels)."
              : extraction.warning_prefix_bold === "not_bold"
                ? "AI check suggests the prefix may NOT be bold (required by 27 CFR 16.22(a)(2)). Verify on the label."
                : "Could not judge bold type — verify on the label.",
        };
  const sizeNote = result.warning.notes.find((n) => /small/i.test(n));
  const showWarningDiff = wv === "fail_wording";

  return (
    <div className="flex flex-col gap-5">
      {/* Banner */}
      <div className={`flex flex-wrap items-start gap-3 rounded-xl border p-4 ${banner.cls}`}>
        <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white ${banner.iconCls}`}>
          {banner.icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className={`text-[16px] font-bold ${banner.titleCls}`}>{banner.title}</p>
          <p className="text-[13.5px] text-ink-soft">{banner.sub}</p>
          <p className="mt-1 text-[12.5px] font-medium text-ink-soft">{countBits.join("  ·  ")}</p>
        </div>
        {ms !== undefined && (
          <span className="text-[12.5px] text-ink-faint">Checked in {(ms / 1000).toFixed(1)}s</span>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-[5fr_4fr]">
        {/* Comparison list */}
        <section>
          <p className="mb-2 text-[11.5px] font-semibold uppercase tracking-wider text-ink-faint">Comparison</p>
          <div className="overflow-hidden rounded-xl border border-hairline bg-card">
            {result.fields.map((f) => {
              const locatable = LOCATABLE.has(f.field) && f.verdict !== "not_provided" && f.verdict !== "absent_on_label";
              const isActive = activeField === f.field;
              const highlight =
                f.verdict === "possible_mismatch" ? "bg-bad-bg/60" : isActive ? "bg-ok-bg/60" : "";
              return (
                <button
                  key={f.field}
                  disabled={!locatable}
                  onClick={() => setActiveField(isActive ? null : (f.field as BandField))}
                  aria-label={`${FIELD_LABELS[f.field]}: ${f.verdict.replace(/_/g, " ")}${locatable ? " — show on label" : ""}`}
                  className={`flex w-full items-center gap-3 border-b border-hairline px-4 py-3 text-left last:border-0 ${highlight} ${locatable ? "cursor-pointer hover:bg-muted-bg/70" : "cursor-default"}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-semibold text-ink-soft">{FIELD_LABELS[f.field]}</span>
                    {f.verdict === "possible_mismatch" ? (
                      <span className="block text-[14px]">
                        <span className="text-ink">{f.applicationValue}</span>
                        <span className="mx-2 text-ink-faint">→ label shows</span>
                        <span className="font-medium text-bad">{f.labelValue || "—"}</span>
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
            {/* Government warning as a comparison row when it needs attention */}
            {(counts.warningFails || counts.warningReview) && (
              <button
                onClick={() => setActiveField(activeField === "warning" ? null : "warning")}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left ${counts.warningFails ? "bg-bad-bg/60" : "bg-warn-bg/60"}`}
                aria-label="Government warning — show on label"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-semibold text-ink-soft">Government warning</span>
                  <span className="block text-[13.5px] text-ink">{result.warning.notes[0]}</span>
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
            activeField={activeField}
            tone={
              activeField
                ? (rowTone(
                    result.fields.find((f) => f.field === activeField)?.verdict ??
                      (counts.warningFails ? "possible_mismatch" : "match"),
                  ) as "ok" | "warn" | "bad")
                : "ok"
            }
          />
          <p className="mt-1.5 text-[12px] text-ink-faint">
            Click a row to show it on the label. Highlights are located automatically and may be approximate.
          </p>
        </section>
      </div>

      {/* Government warning panel */}
      <section className="rounded-xl border border-hairline bg-card">
        <p className="border-b border-hairline px-4 py-2.5 text-[11.5px] font-semibold uppercase tracking-wider text-ink-faint">
          Government warning
        </p>
        <div className="flex items-start gap-4 border-b border-hairline px-4 py-3">
          <span className="w-24 shrink-0 pt-0.5 text-[13px] font-semibold text-ink-soft">Wording</span>
          <span className="min-w-0 flex-1 text-[13.5px] text-ink">{wordingRow.text}</span>
          {wordingRow.chip}
        </div>
        <div className="flex items-start gap-4 px-4 py-3">
          <span className="w-24 shrink-0 pt-0.5 text-[13px] font-semibold text-ink-soft">Formatting</span>
          <span className="min-w-0 flex-1 text-[13.5px] text-ink">{formattingRow.text}</span>
          <div className="flex shrink-0 items-center gap-2">
            {formattingRow.chip}
            <button
              onClick={() => setActiveField(activeField === "warning" ? null : "warning")}
              className="no-print rounded-lg border border-hairline px-2.5 py-1 text-[12px] font-semibold text-ink-soft hover:bg-muted-bg"
            >
              Show on label
            </button>
          </div>
        </div>
        {sizeNote && (
          <div className="flex items-start gap-4 border-t border-hairline px-4 py-3">
            <span className="w-24 shrink-0 pt-0.5 text-[13px] font-semibold text-ink-soft">Size</span>
            <span className="min-w-0 flex-1 text-[13.5px] text-ink">{sizeNote}</span>
            <Chip tone="warn">Review</Chip>
          </div>
        )}
        {showWarningDiff && result.warning.labelText && (
          <div className="border-t border-hairline px-4 py-3">
            <p className="mb-1 text-[12px] text-ink-faint">
              Label text vs required text — <del className="rounded-sm bg-bad-bg px-0.5 text-bad line-through">struck</del> = required text the label gets wrong ·{" "}
              <ins className="rounded-sm border-b-2 border-ok bg-ok-bg px-0.5 text-ok no-underline">marked</ins> = what the label prints
            </p>
            <CharDiff expected={CANONICAL_WARNING} actual={result.warning.labelText} />
          </div>
        )}
      </section>

      {onPrint && (
        <div className="no-print flex items-center justify-between">
          <button
            onClick={onPrint}
            className="flex items-center gap-2 rounded-xl border border-hairline bg-card px-4 py-2.5 text-[14px] font-semibold text-ink-soft hover:bg-muted-bg"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Download report
          </button>
        </div>
      )}
    </div>
  );
}
