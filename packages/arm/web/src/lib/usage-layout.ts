export interface UsageLayout {
  rows: number[][];
  widths: number[];
  width: number;
}

/** Mac UsagePeekLayout detail plan: balanced ordered rows, weighted by ring count. */
export function detailUsageLayout(rings: number[], limit = 790): UsageLayout {
  const padding = 18, gap = 12;
  if (!rings.length) return { rows: [], widths: [], width: Math.min(420, limit) };
  const minimums = rings.map((count) => count >= 2 ? 232 : 190);
  const inner = Math.max(0, limit - padding * 2);
  const rowWidth = (start: number, end: number) => minimums.slice(start, end).reduce((a, b) => a + b, 0) + gap * Math.max(0, end - start - 1);
  let count = 1, current = 0;
  minimums.forEach((width, index) => {
    const added = current === 0 ? width : current + gap + width;
    if (added > inner && index > 0 && current > 0) { count++; current = width; }
    else current = added;
  });
  const n = minimums.length, k = Math.min(count, n);
  const best = Array.from({ length: k + 1 }, () => Array<number>(n + 1).fill(Infinity));
  const cut = Array.from({ length: k + 1 }, () => Array<number>(n + 1).fill(0));
  best[0][0] = 0;
  for (let rows = 1; rows <= k; rows++) {
    for (let end = rows; end <= n; end++) {
      for (let start = rows - 1; start < end; start++) {
        const width = Math.max(best[rows - 1][start], rowWidth(start, end));
        if (width < best[rows][end] - 0.01) { best[rows][end] = width; cut[rows][end] = start; }
      }
    }
  }
  const rows: number[][] = [];
  let end = n;
  for (let r = k; r > 0; r--) {
    const start = cut[r][end];
    rows.unshift(Array.from({ length: end - start }, (_, i) => start + i));
    end = start;
  }
  const totals = rows.map((row) => row.reduce((sum, i) => sum + minimums[i], 0));
  const natural = Math.max(...rows.map((row, i) => totals[i] * 1.18 + gap * (row.length - 1)));
  const widest = Math.max(...rows.map((row, i) => totals[i] + gap * (row.length - 1)));
  const content = Math.min(inner, Math.max(widest, natural));
  const widths = Array<number>(n).fill(0);
  rows.forEach((row, r) => row.forEach((i) => { widths[i] = Math.floor(minimums[i] / totals[r] * (content - gap * (row.length - 1))); }));
  return { rows, widths, width: content + padding * 2 };
}
