"use client";

/** v2 stepper (design §Stepper): Application details · Label check · Result.
 *  The terminal step carries the OUTCOME, not just completion. */

export type StepPhase = "form" | "checking" | "result";
export type Outcome = { tone: "ok" | "warn" | "bad"; label: string } | null;

const TONES = {
  ok: { dot: "bg-green text-white", text: "text-green" },
  warn: { dot: "bg-amber text-white", text: "text-amber" },
  bad: { dot: "bg-red text-white", text: "text-red" },
};

export function Stepper({ phase, outcome }: { phase: StepPhase; outcome: Outcome }) {
  const steps = [
    { label: "Application details", state: phase === "form" ? "current" : "complete" },
    { label: "Label check", state: phase === "form" ? "upcoming" : phase === "checking" ? "current" : "complete" },
    {
      label: phase === "result" && outcome ? `Result: ${outcome.label}` : "Result",
      state: phase === "result" ? "terminal" : "upcoming",
    },
  ] as const;

  return (
    <div className="flex flex-none items-center" aria-label="Progress">
      {steps.map((s, i) => {
        const isTerminal = s.state === "terminal" && outcome;
        const dotCls =
          s.state === "complete"
            ? "bg-green text-white"
            : s.state === "current"
              ? "bg-navy text-white"
              : isTerminal
                ? TONES[outcome!.tone].dot
                : "bg-line-soft text-muted-2";
        const labelCls =
          s.state === "complete"
            ? "text-green"
            : s.state === "current"
              ? "font-bold text-ink"
              : isTerminal
                ? `font-bold ${TONES[outcome!.tone].text}`
                : "text-muted-2";
        const glyph =
          s.state === "complete" ? "✓" : isTerminal ? (outcome!.tone === "ok" ? "✓" : outcome!.tone === "warn" ? "!" : "✕") : i + 1;
        return (
          <span key={i} className="flex items-center">
            {i > 0 && (
              <span
                className={`mx-3.5 h-[1.5px] w-9 ${steps[i - 1].state === "complete" ? "bg-green" : "bg-line-soft"}`}
                aria-hidden
              />
            )}
            <span className={`flex h-[22px] w-[22px] items-center justify-center rounded-full text-[11px] font-bold ${dotCls}`} aria-hidden>
              {glyph}
            </span>
            <span className={`ml-2 whitespace-nowrap text-[13px] ${labelCls}`}>{s.label}</span>
          </span>
        );
      })}
    </div>
  );
}
