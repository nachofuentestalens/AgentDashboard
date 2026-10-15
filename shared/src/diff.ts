export type DiffLine = { type: "same" | "add" | "del"; text: string };

// Above this many cells the LCS table is too big to be worth it; show a full replacement instead.
const MAX_CELLS = 4_000_000;

// Line diff for proposal reviews: the longest common subsequence, then a walk that emits deletions
// before additions, like a unified diff.
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.replace(/\r\n/g, "\n").split("\n");
  const b = after === "" ? [] : after.replace(/\r\n/g, "\n").split("\n");
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) return [...a.map((text) => ({ type: "del" as const, text })), ...b.map((text) => ({ type: "add" as const, text }))];

  // lcs[i][j] = length of the LCS of a[i..] and b[j..], flattened.
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      out.push({ type: "del", text: a[i++]! });
    } else {
      out.push({ type: "add", text: b[j++]! });
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++]! });
  while (j < m) out.push({ type: "add", text: b[j++]! });
  return out;
}
