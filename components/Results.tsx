"use client";

import type { CheckResult } from "@/lib/compare/index.ts";
import { CANONICAL_WARNING } from "@/lib/compare/canonical.ts";
import { CharDiff } from "./CharDiff.tsx";
import { FIELD_LABELS, FIELD_VERDICT_UI, WARNING_VERDICT_UI } from "./verdicts.tsx";

/** Side-by-side evidence view: label image on one side, per-field comparison
 *  on the other. Every AI-read value sits next to the application value so an
 *  agent can verify at a glance (the results screen IS the product). */
export function Results({
  result,
  imageUrl,
  ms,
}: {
  result: CheckResult;
  imageUrl: string;
  ms?: number;
}) {
  if (!result.is_alcohol_label) {
    return (
      <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-6 text-lg">
        <p className="font-semibold">⚠ This doesn&apos;t look like an alcohol label.</p>
        <p className="mt-1 text-stone-700">
          Check that the right image was uploaded, then try again.
        </p>
      </div>
    );
  }

  const wUi = WARNING_VERDICT_UI[result.warning.verdict];
  const showWarningDiff =
    result.warning.verdict === "fail_wording" || result.warning.verdict === "fail_prefix_case";

  return (
    <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl}
        alt="Uploaded label"
        className="w-full self-start rounded-xl border border-stone-300 shadow-sm"
      />
      <div className="flex flex-col gap-4">
        {/* Government warning verdict — the one hard pass/fail */}
        <section className={`rounded-xl border-2 p-4 ${wUi.className}`}>
          <p className="text-lg font-bold">
            <span aria-hidden>{wUi.icon}</span> Government warning: {wUi.label}
          </p>
          {result.warning.notes.map((n, i) => (
            <p key={i} className="mt-1 text-sm">
              {n}
            </p>
          ))}
          {showWarningDiff && result.warning.labelText && (
            <div className="mt-3 rounded-lg bg-white/70 p-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
                Label text vs required text
              </p>
              <CharDiff expected={CANONICAL_WARNING} actual={result.warning.labelText} />
            </div>
          )}
        </section>

        {/* Field comparisons — evidence, not judgment */}
        <section className="overflow-hidden rounded-xl border border-stone-300">
          <table className="w-full text-left text-sm">
            <thead className="bg-stone-100 text-stone-600">
              <tr>
                <th className="p-3 font-semibold">Field</th>
                <th className="p-3 font-semibold">Application says</th>
                <th className="p-3 font-semibold">Label shows</th>
                <th className="p-3 font-semibold">Result</th>
              </tr>
            </thead>
            <tbody>
              {result.fields.map((f) => {
                const ui = FIELD_VERDICT_UI[f.verdict];
                const interesting = f.verdict === "match_formatting" || f.verdict === "possible_mismatch";
                return (
                  <tr key={f.field} className="border-t border-stone-200 align-top">
                    <td className="p-3 font-medium">{FIELD_LABELS[f.field] ?? f.field}</td>
                    <td className="p-3">{f.applicationValue || <span className="text-stone-400">—</span>}</td>
                    <td className="p-3">
                      {interesting ? (
                        <CharDiff expected={f.applicationValue} actual={f.labelValue} />
                      ) : (
                        f.labelValue || <span className="text-stone-400">—</span>
                      )}
                    </td>
                    <td className="p-3">
                      <span
                        className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${ui.className}`}
                      >
                        <span aria-hidden>{ui.icon}</span> {ui.label}
                      </span>
                      {f.note && <p className="mt-1 max-w-[16rem] text-xs text-stone-600">{f.note}</p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        {ms !== undefined && (
          <p className="text-right text-xs text-stone-400">Checked in {(ms / 1000).toFixed(1)} s</p>
        )}
      </div>
    </div>
  );
}
