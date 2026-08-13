/**
 * Post-deskew single-label latency on the DEPLOYED app.
 *
 * Separate from scripts/measure.ts on purpose: that script rewrites
 * docs/measured-performance.json wholesale, including the 250-row batch
 * result, and re-running it just to refresh one row would either destroy that
 * evidence or cost another 250 paid checks. This writes its own file.
 *
 * Measures the SERVER path (upload → verdict JSON) from node, which has no
 * browser timer throttling. Client-side preparation is measured separately —
 * see approach.md; a browser-side end-to-end number must be taken in a
 * FOREGROUNDED tab, because a hidden/non-compositing pane clamps timers and
 * inflates the result (the trap already recorded in approach.md).
 *
 * Run: node scripts/measure-post-deskew.mjs [n]
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.MEASURE_BASE ?? "https://labelcheck-production-8f22.up.railway.app";
const N = parseInt(process.argv[2] ?? "6", 10);

const root = path.join(import.meta.dirname, "..");
const APP = {
  brand_name: "OLD TOM DISTILLERY",
  class_type: "Kentucky Straight Bourbon Whiskey",
  alcohol_content: "45% Alc./Vol. (90 Proof)",
  net_contents: "750 mL",
};

async function check(pngPath) {
  const form = new FormData();
  const bytes = fs.readFileSync(pngPath);
  form.set("image", new File([new Uint8Array(bytes)], path.basename(pngPath), { type: "image/png" }));
  // The single-check path the UI actually uses: provisional verdict first,
  // confirmation asynchronous. Omitting this times the BATCH path instead.
  form.set("async_confirm", "1");
  for (const [k, v] of Object.entries(APP)) form.set(k, v);
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/check`, { method: "POST", body: form });
  const body = await res.json().catch(() => null);
  return {
    ms: Math.round(performance.now() - t0),
    server_ms: body?.ms ?? null,
    ok: res.ok,
    status: res.status,
  };
}

const png = path.join(root, "samples", "labels", "clean-match.png");
const runs = [];
for (let i = 0; i < N; i++) {
  const r = await check(png);
  console.log(`  #${i + 1}: ${r.ms}ms round-trip, server ${r.server_ms}ms${r.ok ? "" : ` — HTTP ${r.status} EXCLUDED`}`);
  if (r.ok) runs.push(r);
}

const sorted = runs.map((r) => r.ms).sort((a, b) => a - b);
const p50 = sorted[Math.floor(sorted.length / 2)];
const worst = sorted[sorted.length - 1];
console.log(`p50 ${p50}ms, worst ${worst}ms over n=${runs.length}`);

fs.writeFileSync(
  path.join(root, "docs", "post-deskew-latency.json"),
  JSON.stringify(
    {
      measured_at: new Date().toISOString(),
      base: BASE,
      what: "single-label server path (upload → verdict JSON), post-deskew, async_confirm=1",
      excludes: "client-side prepareImage (downscale + deskew), measured separately at 26–197ms",
      note: "Measured from node. A browser-side end-to-end number requires a foregrounded tab; a hidden pane throttles timers and inflates it.",
      n: runs.length,
      p50_ms: p50,
      worst_ms: worst,
      runs,
    },
    null,
    2,
  ),
);
console.log("Written docs/post-deskew-latency.json");
