// Fail the build when the docs assert a count that the repo contradicts.
//
// Why: the test count has now drifted three separate times (docs/decisions.md
// records an earlier "81 tests -> 85, 18 labels -> 20" correction; today the
// docs said 88 tests and 20 labels while the repo held 115 and 35). Numbers
// asserted by hand in prose go stale silently, and a stale number in a
// requirements document is worse than no number — it reads as evidence.
//
// This derives the truth from the filesystem and diffs it against every claim
// in the docs, so drift becomes a failing check instead of an audit finding.
//
//   node scripts/check-doc-counts.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * The number of tests that actually RUN.
 *
 * This used to grep for `it(` in the source, which was fine until a test file
 * generated cases in a loop (four label templates × several defects from one
 * `it(`). The static count then read 166 against a real 186 — the drift the
 * gate exists to catch, produced by the gate itself. So ask the runner.
 *
 * Falls back to the grep if vitest can't be invoked, and says so, because a
 * degraded check that announces itself beats one that silently guesses.
 */
function actualTests() {
  try {
    // Invoke vitest's own entry point with this node binary: no shell, so no
    // quoting differences between Windows and CI, and no deprecation warning.
    const out = execFileSync(process.execPath, [
      path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
      'run', '--reporter=json', '--silent',
    ], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    // The JSON report may be preceded by runner chatter; take the last object.
    const start = out.indexOf('{"numTotalTestSuites"');
    const parsed = JSON.parse(start >= 0 ? out.slice(start) : out);
    if (typeof parsed.numTotalTests === 'number') return parsed.numTotalTests;
  } catch {
    /* fall through to the static estimate */
  }
  let n = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel); continue; }
      if (!/\.test\.ts$/.test(e.name)) continue;
      n += (read(rel).match(/^\s*(it|test)\(/gm) ?? []).length;
    }
  };
  walk('lib');
  console.warn('!! could not run vitest — falling back to a STATIC count, which undercounts loop-generated tests');
  return n;
}

const actual = {
  tests: actualTests(),
  labels: fs.readdirSync(path.join(ROOT, 'samples', 'labels')).filter((f) => f.endsWith('.png')).length,
};

// Files whose prose makes countable claims.
const DOCS = ['README.md', 'docs/approach.md', 'docs/rubric.md', 'docs/submission.md'];
// Code comments duplicate these numbers too — same drift risk, same check.
const CODE = ['lib/vision/extract.ts', 'lib/compare/types.ts'];

const problems = [];

for (const f of [...DOCS, ...CODE]) {
  const full = path.join(ROOT, f);
  if (!fs.existsSync(full)) continue;
  const src = read(f);
  src.split('\n').forEach((line, i) => {
    // "88 tests", "104 engine tests"
    for (const m of line.matchAll(/(\d+)\s+(?:engine\s+)?tests\b/gi)) {
      const claimed = Number(m[1]);
      if (claimed !== actual.tests && claimed > 10)
        problems.push(`${f}:${i + 1}  claims "${m[0]}" but the repo has ${actual.tests}`);
    }
    // "20 rendered test labels" / "20 test labels" — phrases that unambiguously
    // mean the samples/labels directory. Deliberately NOT matching bare
    // "N ground-truthed labels": that phrase is also used for measurement sets
    // of a different size (e.g. the 45-label bold validation set), and flagging
    // a legitimately different number would train the reader to ignore this
    // check — the opposite of the point.
    for (const m of line.matchAll(/(\d+)\s+(?:rendered\s+)?(?:ground-truthed\s+)?test\s+labels\b/gi)) {
      const claimed = Number(m[1]);
      if (claimed && claimed !== actual.labels)
        problems.push(`${f}:${i + 1}  claims "${m[0].trim()}" but samples/labels holds ${actual.labels}`);
    }
  });
}

console.log(`derived from the repo: ${actual.tests} tests, ${actual.labels} sample labels`);
if (problems.length) {
  console.error(`\n!! ${problems.length} stale count(s) in documentation:`);
  for (const p of problems) console.error('   ' + p);
  console.error('\nUpdate the prose, or the number stops being evidence.');
  process.exit(1);
}
console.log('no stale counts found');
