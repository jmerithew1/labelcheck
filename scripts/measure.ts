/**
 * Phase 3a: measured performance on the DEPLOYED app (not localhost).
 * - P1: n single checks → p50 + worst case (statistic pinned in the plan)
 * - P3: batch wall-clock at CONCURRENCY=8 over ROWS rows (replicated samples)
 * Run: node scripts/measure.ts [singleN] [batchRows]
 * Writes docs/measured-performance.json.
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.MEASURE_BASE ?? "https://labelcheck-production-8f22.up.railway.app";
const SINGLE_N = parseInt(process.argv[2] ?? "7", 10);
const BATCH_ROWS = parseInt(process.argv[3] ?? "250", 10);
const CONCURRENCY = 8;

const root = path.join(import.meta.dirname, "..");
const imageDir = path.join(root, "samples", "batch", "images");
const imageFiles = fs.readdirSync(imageDir).filter((f) => f.endsWith(".png"));

const APP = {
  brand_name: "OLD TOM DISTILLERY",
  class_type: "Kentucky Straight Bourbon Whiskey",
  alcohol_content: "45% Alc./Vol. (90 Proof)",
  net_contents: "750 mL",
};

function formFor(pngPath: string): FormData {
  const form = new FormData();
  const bytes = fs.readFileSync(pngPath);
  form.set("image", new File([new Uint8Array(bytes)], path.basename(pngPath), { type: "image/png" }));
  for (const [k, v] of Object.entries(APP)) form.set(k, v);
  return form;
}

async function check(pngPath: string): Promise<{ ms: number; ok: boolean; status: number }> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/api/check`, { method: "POST", body: formFor(pngPath) });
    await res.json().catch(() => null);
    return { ms: Math.round(performance.now() - t0), ok: res.ok, status: res.status };
  } catch {
    return { ms: Math.round(performance.now() - t0), ok: false, status: 0 };
  }
}

async function main() {
  console.log(`Target: ${BASE}`);

  // P1 — single-check latency
  const cleanPng = path.join(root, "samples", "labels", "clean-match.png");
  const singles: number[] = [];
  for (let i = 0; i < SINGLE_N; i++) {
    const r = await check(cleanPng);
    if (!r.ok) console.log(`  single #${i + 1}: HTTP ${r.status} (${r.ms}ms) — EXCLUDED`);
    else {
      singles.push(r.ms);
      console.log(`  single #${i + 1}: ${r.ms}ms`);
    }
  }
  const sorted = [...singles].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)];
  const worst = sorted[sorted.length - 1];
  console.log(`P1: p50 ${p50}ms, worst ${worst}ms over n=${singles.length}`);

  // P3 — batch wall-clock, semaphore CONCURRENCY, BATCH_ROWS rows
  const rows = Array.from({ length: BATCH_ROWS }, (_, i) =>
    path.join(imageDir, imageFiles[i % imageFiles.length]),
  );
  let next = 0;
  let ok = 0, errors = 0, rateLimited = 0;
  const t0 = performance.now();
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= rows.length) return;
      const r = await check(rows[i]);
      if (r.ok) ok++;
      else if (r.status === 429) rateLimited++;
      else errors++;
      const done = ok + errors + rateLimited;
      if (done % 25 === 0) console.log(`  batch: ${done}/${rows.length} (${Math.round((performance.now() - t0) / 1000)}s)`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const wallMs = Math.round(performance.now() - t0);
  console.log(`P3: ${BATCH_ROWS} rows in ${(wallMs / 1000).toFixed(0)}s (ok ${ok}, 429s ${rateLimited}, errors ${errors})`);

  const out = {
    measured_at: new Date().toISOString(),
    base: BASE,
    p1_single: { n: singles.length, p50_ms: p50, worst_ms: worst, all_ms: singles },
    p3_batch: { rows: BATCH_ROWS, concurrency: CONCURRENCY, wall_ms: wallMs, ok, rate_limited: rateLimited, errors },
  };
  fs.writeFileSync(path.join(root, "docs", "measured-performance.json"), JSON.stringify(out, null, 2));
  console.log("Written docs/measured-performance.json");
}

main();
