// Fail the build when a number in the docs contradicts itself, its own
// arithmetic, or the evidence file that is the source of truth for it.
//
// Why: the docs carried "roughly three and a half minutes for a 250-label
// batch" for a pass measured at 11.9 rows/min over 208 rows — 17.5 minutes.
// The error was found by dividing two numbers that sat in the same JSON
// object, which no human audit is guaranteed to repeat. Its sibling,
// check-doc-counts.mjs, verifies counts derivable from the filesystem; this
// one verifies the claims' own arithmetic and their agreement with the
// committed evidence.
//
//   node scripts/check-doc-numbers.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(read(p));

const DOCS = ['README.md', 'docs/approach.md', 'docs/rubric.md', 'docs/submission.md', 'docs/spike-results.md', 'docs/spec.md'];
// decisions.md is append-only history: old entries record what was believed
// at the time, corrections are appended rather than edited in place, so its
// arithmetic is deliberately NOT gated. It still participates in nothing —
// gating it would force editing the record.

const failures = [];
const flag = (file, quote, why) => failures.push({ file, quote: quote.slice(0, 110), why });

// Strip markdown emphasis so "**3 of 160 — 1.9%**" parses like plain text.
const plain = (s) => s.replace(/\*\*|\*|`/g, '');

// ---------- Layer 1: internal arithmetic of "A of B (C%)" claims ----------
// Forms: "A of B (C%)", "A of B — C%", "A/B (C%)", "C% of B samples" is not
// checkable alone and is skipped.
const ratioRe = /(\d[\d,]*)\s*(?:of|\/)\s*(\d[\d,]*)\s*(?:\(|—\s*|- )\s*(\d+(?:\.\d+)?)\s*%/g;
for (const f of DOCS) {
  const text = plain(read(f));
  for (const m of text.matchAll(ratioRe)) {
    const a = Number(m[1].replace(/,/g, ''));
    const b = Number(m[2].replace(/,/g, ''));
    const pct = Number(m[3]);
    if (b === 0 || a > b) { flag(f, m[0], `numerator exceeds denominator`); continue; }
    const real = (a / b) * 100;
    // Tolerance: the doc may round to 0 or 1 decimals.
    if (Math.abs(real - pct) > 0.55) {
      flag(f, m[0], `${a}/${b} is ${real.toFixed(2)}%, doc says ${pct}%`);
    }
  }
}

// ---------- Layer 2: rate × time claims ----------
// Any sentence carrying "<rows> rows", "<rate> rows/min" (or "rows per
// minute") and "<t> minutes" must divide correctly. This is exactly the
// class the 3.5-vs-17.5-minute error belonged to.
for (const f of DOCS) {
  const text = plain(read(f));
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const rate = sentence.match(/(\d+(?:\.\d+)?)\s*rows?\s*(?:\/|per\s+)min/i);
    const rows = sentence.match(/(\d{2,4})\s+(?:eligible\s+)?rows/i);
    const mins = sentence.match(/~?\s*(\d+(?:\.\d+)?)\s*min/i);
    if (rate && rows && mins) {
      const expect = Number(rows[1]) / Number(rate[1]);
      const claimed = Number(mins[1]);
      if (Math.abs(expect - claimed) / expect > 0.15) {
        flag(f, sentence.trim(), `${rows[1]} rows at ${rate[1]} rows/min is ${expect.toFixed(1)} min, doc says ${claimed}`);
      }
    }
  }
}

// ---------- Layer 3: recurring figures must match their evidence file ----------
// Each entry: the truth read from the committed evidence, and a regex whose
// FIRST capture group is the value every doc occurrence must equal.
const latency = json('docs/latency-p95.json');
const rescore = json('docs/bold-gate-rescore.json');
const postfix = json('docs/batch-ui-250-postfix.json');

const KEY_FIGURES = [
  // p50 is NOT keyed: several distinct measured runs legitimately report
  // different p50s (n=30 deployed 4.58, post-deskew 4.06, locator spike
  // 1.75). p90/p95 exist only for the n=30 run, so they pin uniquely. The
  // "N of 160" family is not keyed either — 3 (gate), 47 (advisory), 7, 80
  // and 150 are all real figures on the same corpus; only the phrase
  // "N silent miss" is uniquely the gate's number.
  { name: 'p90 latency', truth: (latency.p90 / 1000).toFixed(2), re: /p90\s+(\d\.\d{2})\s*s/g },
  { name: 'p95 latency', truth: (latency.p95 / 1000).toFixed(2), re: /p95(?:\s+is)?\s+(\d\.\d{2})\s*s/g },
  { name: 'gate silent misses', truth: String(rescore.green_leaks), re: /(\d+)\s+silent miss/g },
  { name: '250-run completed', truth: String(postfix.check_pass.completed), re: /250\/(\d+)\s+completed/g },
];
for (const f of DOCS) {
  const text = plain(read(f));
  for (const k of KEY_FIGURES) {
    for (const m of text.matchAll(k.re)) {
      if (m[1] !== k.truth) flag(f, m[0], `${k.name}: evidence says ${k.truth}, doc says ${m[1]}`);
    }
  }
}

// ---------- Layer 4: sanity — a claim citing a docs/*.json must cite one that exists ----------
for (const f of DOCS) {
  const text = read(f);
  for (const m of text.matchAll(/\]\(((?:\.\.\/)?[\w./-]+\.json)\)/g)) {
    // Resolve the link the way markdown does: relative to the citing file.
    const target = path.resolve(ROOT, path.dirname(f), m[1]);
    if (!fs.existsSync(target)) flag(f, m[0], `cites ${m[1]}, which does not exist`);
  }
}

if (failures.length) {
  console.error(`check-doc-numbers: ${failures.length} failing claim(s)\n`);
  for (const x of failures) console.error(`  ${x.file}\n    "${x.quote}"\n    -> ${x.why}\n`);
  process.exit(1);
}
console.log('doc numbers check out (arithmetic, rates, key figures, evidence links)');
