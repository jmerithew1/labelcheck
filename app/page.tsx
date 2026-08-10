import Link from "next/link";
import { CheckForm } from "@/components/CheckForm.tsx";

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl p-6 md:p-10">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">LabelCheck</h1>
          <p className="mt-1 text-stone-600">
            Does the label match the application? Upload, check, decide.
          </p>
        </div>
        <Link
          href="/batch"
          className="rounded-xl border-2 border-blue-700 px-5 py-2.5 text-base font-bold text-blue-700 transition hover:bg-blue-50"
        >
          Check a batch →
        </Link>
      </header>
      <CheckForm />
    </main>
  );
}
