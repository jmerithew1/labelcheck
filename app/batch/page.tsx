import Link from "next/link";
import { BatchRunner } from "@/components/BatchRunner.tsx";

export default function BatchPage() {
  return (
    <main className="mx-auto max-w-6xl p-6 md:p-10">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Check a batch</h1>
          <p className="mt-1 text-stone-600">
            Upload an application CSV and the label images. Results appear as each label finishes —
            problems first.
          </p>
        </div>
        <Link
          href="/"
          className="rounded-xl border-2 border-blue-700 px-5 py-2.5 text-base font-bold text-blue-700 transition hover:bg-blue-50"
        >
          ← Single check
        </Link>
      </header>
      <BatchRunner />
    </main>
  );
}
