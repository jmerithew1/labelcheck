"use client";

import { useEffect, useState } from "react";

/** v2 checking state (design §Checking): the label under an animated scan
 *  line plus a 3-phase checklist. The prototype faked 2s; ours paces to the
 *  real request (~4s typical, ~8s when a second warning reading runs) —
 *  phases advance on a timer, all complete only when the response lands. */
export function CheckingCard({ imageUrl }: { imageUrl: string | null }) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const t1 = setTimeout(() => setPhase(1), 1300);
    const t2 = setTimeout(() => setPhase(2), 2600);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  const steps = [
    "Extracting text from the label",
    "Comparing fields to the application",
    "Scanning government warning",
  ];

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-6 rounded-xl border border-line bg-card p-8">
      <div className="relative overflow-hidden rounded-md border border-paper-line">
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt="Label being checked" className="block w-[170px]" />
        ) : (
          <div className="h-[240px] w-[170px] bg-paper" />
        )}
        <div className="scanline pointer-events-none absolute inset-x-0 h-[2px] bg-[#2b5f9e] shadow-[0_0_8px_2px_rgba(43,95,158,0.55)]" aria-hidden />
      </div>
      <ul className="flex w-full flex-col gap-3">
        {steps.map((label, i) => {
          const done = i < phase;
          const active = i === phase;
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
      <p className="text-[12px] text-muted-2">usually under 5 seconds</p>
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
