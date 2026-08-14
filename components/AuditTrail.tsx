"use client";

import type { CheckResult } from "@/lib/compare/index.ts";

/** Audit trail (design timeline style, REAL entries — no fake confidence
 *  numbers, and an honest closing note: nothing is stored).
 *
 *  Shared by both surfaces on purpose. It lived inside BatchReview and was
 *  coupled to a BatchRow, which is how the single-check page ended up with no
 *  audit trail at all: the same label was fully traceable when it arrived in a
 *  batch and completely opaque when a person checked it by hand. For a tool
 *  whose pitch is "evidence-linked and audit-ready", that was the wrong half
 *  to be missing.
 *
 *  Plain English first (Margaret finding #1); technical identifiers in
 *  parentheses for auditors who need them. */
export function AuditTrail({
  filename,
  fileSizeBytes,
  prepared,
  isPdf,
  ms,
  checkedAt,
  result,
}: {
  filename: string;
  /** original upload size, before any browser preparation */
  fileSizeBytes?: number;
  /** did prepareImage actually change the file? An audit found this entry
   *  claiming "shrunk in your browser" unconditionally, while small images
   *  are sent byte-for-byte as uploaded and PDFs never touch the prepare
   *  path at all — a false statement in the one artifact whose entire job
   *  is to be a truthful record. undefined = unknown, say nothing. */
  prepared?: boolean;
  isPdf?: boolean;
  /** time to the verdict on screen */
  ms?: number;
  checkedAt?: Date;
  result: CheckResult;
}) {
  const confirmed = result.warning.notes.some((n) => /second independent/i.test(n));
  const overturned = result.warning.notes.some((n) => /readings.*disagree/i.test(n));
  const ts = checkedAt ? checkedAt.toLocaleTimeString() : undefined;

  const items: { t: string; d: string }[] = [
    {
      t: "Label uploaded",
      d: `${filename}${fileSizeBytes ? ` (${(fileSizeBytes / 1024 / 1024).toFixed(1)} MB)` : ""}${
        isPdf ? " — PDF, sent exactly as uploaded."
          : prepared ? " — shrunk or straightened in your browser before sending."
          : prepared === false ? " — sent exactly as uploaded."
          : "."
      }`,
    },
    {
      t: "Text read from the label",
      d: `The computer read the label word for word, exactly as printed, and separately judged whether the warning is in bold type. Took ${ms ? (ms / 1000).toFixed(1) : "?"} seconds (readers: claude-haiku-4-5, claude-sonnet-5).`,
    },
    {
      t: "Compared to the application",
      d: "Fixed rules in the software decide every pass or fail — the computer only reads the label. The warning must match the required text exactly (27 CFR 16.21); the other fields are compared with sensible tolerance for formatting.",
    },
  ];
  if (confirmed) items.push({ t: "Second opinion", d: "Because the warning failed, a second independent reading was taken. It agreed — the failure stands." });
  if (overturned) items.push({ t: "Second opinion", d: "Two independent readings disagreed, so instead of asserting a failure this row was marked for a manual look." });
  items.push({
    t: "Result recorded",
    d: `${result.overall.replace(/_/g, " ")} — warning: ${result.warning.verdict.replace(/_/g, " ")}; ${result.fields.filter((f) => f.verdict === "match" || f.verdict === "match_formatting").length} field(s) matched.`,
  });

  return (
    <div className="flex flex-col">
      <ol className="flex flex-col">
        {items.map((it, i) => (
          <li key={i} className="relative pb-4 pl-5 last:pb-0">
            {i < items.length - 1 && <span className="absolute left-[4px] top-3 h-full w-[1.5px] bg-line" aria-hidden />}
            <span className="absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full bg-navy" aria-hidden />
            <p className="text-[13px] font-bold text-ink">
              {it.t} {ts && i === items.length - 1 && <span className="ml-1 font-normal text-[11.5px] text-muted-2">{ts}</span>}
            </p>
            <p className="text-[12.5px] leading-snug text-muted">{it.d}</p>
          </li>
        ))}
      </ol>
      <p className="mt-4 border-t border-line-soft pt-3 text-[12px] text-muted-2">
        The computer never decides pass or fail — it only reads. Nothing is stored: the evidence lives in this browser session only.
      </p>
    </div>
  );
}
