"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** v2 app shell (design handoff §App shell): 230px sidebar — brand row,
 *  Single check / Batch review nav, footer card pinned by a spacer — that
 *  collapses to 64px icons-only while a detail panel is open. The 64px top
 *  bar is CONTEXTUAL, not navigation: one nowrap flex line carrying either
 *  the single-check stepper or the batch title + actions, nothing else. */
export function Shell({
  children,
  topBar,
  collapsed = false,
}: {
  children: React.ReactNode;
  /** contextual content for the 64px top bar */
  topBar?: React.ReactNode;
  /** icons-only sidebar while a detail panel is open */
  collapsed?: boolean;
}) {
  const path = usePathname();
  const isBatch = path.startsWith("/batch");

  const icon = (d: string) => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden className="shrink-0">
      <path d={d} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

  const navItem = (href: string, label: string, active: boolean, d: string) => (
    <Link
      href={href}
      title={label}
      className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[14px] transition ${
        active ? "bg-navy font-bold text-white" : "font-normal text-muted hover:bg-line-soft"
      } ${collapsed ? "justify-center px-2" : ""}`}
    >
      {icon(d)}
      {!collapsed && label}
    </Link>
  );

  return (
    <div className="flex min-h-screen">
      <aside
        className={`no-print hidden shrink-0 flex-col border-r border-line bg-card transition-all md:flex ${
          collapsed ? "w-16 px-2 pb-5" : "w-[230px] px-4 pb-5"
        }`}
      >
        <Link
          href="/"
          className={`flex h-16 items-center gap-2.5 border-b border-line-soft ${collapsed ? "justify-center" : ""}`}
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] bg-navy" aria-hidden>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3">
              <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          {!collapsed && <span className="text-[19px] font-bold tracking-[-0.3px] text-ink">LabelCheck</span>}
        </Link>
        <nav className="mt-4 flex flex-col gap-1">
          {navItem("/", "Single check", !isBatch, "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 12l2 2 4-4")}
          {navItem("/batch", "Batch review", isBatch, "M4 7h16M4 12h16M4 17h10")}
        </nav>
        <div className="flex-1" />
        {!collapsed && (
          <div className="rounded-[10px] bg-page px-3.5 py-3">
            <p className="text-[12.5px] font-bold text-ink">Secure. Traceable. Explainable.</p>
            <p className="mt-1 text-[12px] leading-snug text-muted">
              Every result is evidence-linked and audit-ready. Nothing is stored.
            </p>
          </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print flex h-16 shrink-0 items-center gap-4 overflow-x-auto whitespace-nowrap border-b border-line bg-card px-7">
          <nav className="flex gap-4 md:hidden">
            <Link href="/" className={`text-[14px] font-bold ${!isBatch ? "text-ink" : "text-muted-2"}`}>Single</Link>
            <Link href="/batch" className={`text-[14px] font-bold ${isBatch ? "text-ink" : "text-muted-2"}`}>Batch</Link>
          </nav>
          {topBar}
        </header>
        <main className="min-w-0 flex-1 p-5 md:p-7">{children}</main>
      </div>
    </div>
  );
}
