"use client";

import { useEffect, useState } from "react";

/** v2 checking state (design §Checking): the label under an animated scan
 *  line plus a 3-phase checklist. The prototype faked 2s; ours paces to the
 *  real request (~4s — the second warning reading no longer blocks here, it
 *  confirms asynchronously on the result screen) — phases advance on a
 *  timer, all complete only when the response lands. */
export function CheckingCard({
  imageUrl,
  isPdf = false,
  complete = false,
  batch,
}: {
  imageUrl: string | null;
  isPdf?: boolean;
  complete?: boolean;
  /** Batch variant: same card, real per-run progress instead of the
   *  single-label phase checklist (phases run concurrently across 8 workers,
   *  so pretending they're sequential would be theatre). */
  batch?: { done: number; total: number; etaLabel?: string };
}) {
  const [phase, setPhase] = useState(0);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t1 = setTimeout(() => setPhase(1), 1300);
    const t2 = setTimeout(() => setPhase(2), 2600);
    // The second warning reading now runs async on the result screen, so
    // >5s here means a genuinely slow request — keep the copy truthful.
    const t3 = setTimeout(() => setSlow(true), 5000);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);
  const shownPhase = complete ? 3 : phase;

  const steps = [
    "Extracting text from the label",
    "Comparing fields to the application",
    "Scanning government warning",
  ];

  return (
    /* Full-width card, label left / checklist right (conformance #9). */
    <div
      className={`mx-auto flex flex-col items-center rounded-xl border border-line bg-card md:flex-row md:items-start ${
        batch
          ? "w-full gap-6 p-5 md:gap-10 md:p-6"
          : "max-w-[1120px] gap-8 p-8 md:justify-center md:gap-14 md:p-12"
      }`}
    >
      <div className="relative shrink-0 overflow-hidden rounded-md border border-paper-line">
        {imageUrl && !isPdf ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt="Label being checked" className={`block ${batch ? "w-[104px]" : "w-[170px]"}`} />
        ) : (
          <div
            className={`flex items-center justify-center bg-paper text-[13px] font-semibold text-ink ${
              batch ? "h-[148px] w-[104px]" : "h-[240px] w-[170px]"
            }`}
          >
            {isPdf ? "PDF" : ""}
          </div>
        )}
        <div className="scanline pointer-events-none absolute inset-x-0 h-[2px] bg-[#2b5f9e] shadow-[0_0_8px_2px_rgba(43,95,158,0.55)]" aria-hidden />
      </div>

      {batch ? (
        <div className="flex w-full flex-col gap-3 md:pt-1">
          <p className="text-[14px] font-bold text-ink">
            Checking {batch.total} labels — {batch.done} done
          </p>
          <span className="h-2 w-full overflow-hidden rounded-full bg-line-soft" role="progressbar" aria-valuenow={batch.done} aria-valuemin={0} aria-valuemax={batch.total}>
            <span
              className="block h-full rounded-full bg-navy transition-[width] duration-300"
              style={{ width: `${batch.total ? (batch.done / batch.total) * 100 : 0}%` }}
            />
          </span>
          <ul className="flex flex-col gap-1.5 text-[12.5px] text-muted">
            {steps.map((label) => (
              <li key={label} className="flex items-center gap-2.5">
                <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-navy border-t-transparent" aria-hidden />
                {label}s
              </li>
            ))}
          </ul>
          <p className="text-[12px] text-muted-2">
            {batch.etaLabel ? `${batch.etaLabel} · ` : ""}finished labels appear below as they land — you can start reviewing now.
          </p>
        </div>
      ) : (
      <div className="flex w-full max-w-sm flex-col gap-6 md:pt-6">
      <ul className="flex w-full flex-col gap-3">
        {steps.map((label, i) => {
          const done = i < shownPhase;
          const active = i === shownPhase;
          return (
            <li key={label} className="flex items-center gap-3 text-[13.5px]">
              {done ? (
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-green text-[10px] font-bold text-white" aria-hidden>✓</span>
              ) : (
                <span
                  className={`h-4 w-4 rounded-full border-2 border-navy border-t-transparent ${active ? "animate-spin" : "opacity-25"}`}
                  aria-hidden
                />
              )}
              <span className={done ? "text-green" : active ? "font-semibold text-ink" : "text-muted-2"}>{label}</span>
            </li>
          );
        })}
      </ul>
      <p className="text-[12px] text-muted-2">
        {slow && !complete
          ? "Taking a little longer than usual — almost there"
          : "usually under 5 seconds"}
      </p>
      </div>
      )}
      <style jsx>{`
        .scanline { animation: scan 2.2s ease-in-out infinite; }
        @keyframes scan {
          0%, 100% { top: 4%; }
          50% { top: 92%; }
        }
      `}</style>
    </div>
  );
}
