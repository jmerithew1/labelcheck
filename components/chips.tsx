import type { FieldVerdict } from "@/lib/compare/types.ts";

/** Status chips — word + icon always, mockup vocabulary. */

export function Chip({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "bad" | "muted" | "info";
  children: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    ok: "bg-ok-bg text-ok border-ok-line",
    warn: "bg-warn-bg text-warn border-warn-line",
    bad: "bg-bad-bg text-bad border-bad-line",
    muted: "bg-muted-bg text-ink-faint border-hairline",
    info: "bg-muted-bg text-ink-soft border-hairline",
  };
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[12px] font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export const Icon = {
  check: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
      <path d="M4 12l5 5L20 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  x: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  ),
  dot: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
      <circle cx="12" cy="12" r="8" /><path d="M8 12h8" strokeLinecap="round" />
    </svg>
  ),
  eye: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" /><circle cx="12" cy="12" r="2.5" />
    </svg>
  ),
};

export function fieldChip(verdict: FieldVerdict): React.ReactNode {
  switch (verdict) {
    case "match":
      return <Chip tone="ok">{Icon.check} Match</Chip>;
    case "match_formatting":
      return <Chip tone="ok">{Icon.check} Match</Chip>;
    case "possible_mismatch":
      return <Chip tone="bad">{Icon.x} Mismatch</Chip>;
    case "absent_on_label":
      return <Chip tone="warn">{Icon.dot} Not found</Chip>;
    case "unreadable":
      return <Chip tone="info">{Icon.eye} Unreadable</Chip>;
    case "not_provided":
      return <Chip tone="muted">{Icon.dot} Not required</Chip>;
  }
}

export const FIELD_LABELS: Record<string, string> = {
  brand_name: "Brand name",
  class_type: "Class / Type",
  alcohol_content: "Alcohol content",
  net_contents: "Net contents",
  bottler_name_address: "Bottler name & address",
  country_of_origin: "Country of origin",
};
