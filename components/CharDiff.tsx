/** Character-level diff for near-matches (C11): shows exactly which
 *  characters differ between what the application says and what the label
 *  shows. LCS-based; fine for field-length strings. */

function lcsDiff(a: string, b: string): Array<{ ch: string; kind: "same" | "a" | "b" }> {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Array<{ ch: string; kind: "same" | "a" | "b" }> = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ ch: a[i], kind: "same" }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ ch: a[i], kind: "a" }); i++; }
    else { out.push({ ch: b[j], kind: "b" }); j++; }
  }
  while (i < m) { out.push({ ch: a[i], kind: "a" }); i++; }
  while (j < n) { out.push({ ch: b[j], kind: "b" }); j++; }
  return out;
}

export function CharDiff({ expected, actual }: { expected: string; actual: string }) {
  const parts = lcsDiff(expected, actual);
  return (
    <span className="font-mono text-sm break-all">
      {parts.map((p, idx) =>
        p.kind === "same" ? (
          <span key={idx}>{p.ch}</span>
        ) : p.kind === "a" ? (
          <del key={idx} className="bg-red-100 text-red-900 no-underline rounded-sm">
            {p.ch}
          </del>
        ) : (
          <ins key={idx} className="bg-green-100 text-green-900 no-underline rounded-sm">
            {p.ch}
          </ins>
        ),
      )}
    </span>
  );
}
