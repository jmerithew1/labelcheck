"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** App shell from the batch mockup: sidebar (wordmark, nav, how-it-works)
 *  + top tab bar. Reports/Settings deliberately omitted — no dead nav. */
export function Shell({
  children,
  topRight,
}: {
  children: React.ReactNode;
  topRight?: React.ReactNode;
}) {
  const path = usePathname();
  const isBatch = path.startsWith("/batch");

  const navItem = (href: string, label: string, active: boolean, icon: React.ReactNode) => (
    <Link
      href={href}
      className={`flex items-center gap-3 rounded-lg px-4 py-2.5 text-[15px] font-medium transition ${
        active ? "bg-navy text-white" : "text-ink-soft hover:bg-muted-bg"
      }`}
    >
      {icon}
      {label}
    </Link>
  );

  const circle = (d: string) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d={d} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="no-print hidden w-60 shrink-0 flex-col border-r border-hairline bg-card px-4 py-6 md:flex">
        <Link href="/" className="px-2 font-display text-[26px] font-bold tracking-tight text-ink">
          LabelCheck
        </Link>
        <nav className="mt-8 flex flex-col gap-1">
          {navItem("/", "Single check", !isBatch, circle("M9 12l2 2 4-4 M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"))}
          {navItem("/batch", "Batch review", isBatch, circle("M4 7h16M4 12h16M4 17h10"))}
        </nav>
        <div className="mt-auto flex flex-col gap-5 pt-8">
          <div className="rounded-xl border border-hairline p-4">
            <p className="mb-3 text-[13px] font-semibold text-ink">How it works</p>
            <ol className="flex flex-col gap-3 text-[12.5px] leading-snug text-ink-soft">
              <li><span className="font-medium text-ink">Upload labels.</span> Images or PDFs of the label.</li>
              <li><span className="font-medium text-ink">Auto check.</span> Each label is compared to its application.</li>
              <li><span className="font-medium text-ink">Review exceptions.</span> Focus only on items that need attention.</li>
            </ol>
          </div>
          <p className="px-1 text-[12px] leading-snug text-ink-faint">
            Secure. Traceable. Explainable.<br />Every result is evidence-linked. Nothing is stored.
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* One nav: the sidebar. This bar only carries the mobile links and
            page actions — no duplicate horizontal tabs. */}
        <header className="no-print flex min-h-14 items-center gap-6 border-b border-hairline bg-card px-6 py-2.5 md:px-8">
          <nav className="flex gap-5 md:hidden">
            <Link href="/" className="font-display text-lg font-bold text-ink">LC</Link>
            <Link href="/" className={`text-[14px] font-semibold ${!isBatch ? "text-ink" : "text-ink-faint"}`}>Single</Link>
            <Link href="/batch" className={`text-[14px] font-semibold ${isBatch ? "text-ink" : "text-ink-faint"}`}>Batch</Link>
          </nav>
          <span className="hidden text-[13px] text-ink-faint md:block">
            {isBatch ? "Batch review" : "Single check"}
          </span>
          {topRight && <div className="ml-auto flex items-center gap-2">{topRight}</div>}
        </header>
        <main className="min-w-0 flex-1 p-5 md:p-8">{children}</main>
      </div>
    </div>
  );
}
