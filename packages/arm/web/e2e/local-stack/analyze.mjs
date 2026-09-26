// analyze(frames) → { frames, blanks, flashes, jumps, log }
export function analyze(frames, { topInset = 64 } = {}) {
  const out = { frames: frames.length, blanks: 0, flashes: 0, jumps: 0, log: [] };
  const lastSeen = new Map();
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    // Blank: an uncovered band between rows inside the visible area (not above
    // the first row / below the last row), bigger than the normal row gap.
    const rows = [...f.rows].sort((a, b) => a.top - b.top);
    for (let k = 1; k < rows.length; k++) {
      const gap = rows[k].top - (rows[k - 1].top + rows[k - 1].h);
      if (gap > 24 && rows[k].top > topInset && rows[k - 1].top + rows[k - 1].h < (f.dockTop ?? f.vh)) {
        out.blanks++; if (out.log.length < 12) out.log.push(`#${i} gap ${gap}px between ${rows[k - 1].key} and ${rows[k].key}`);
      }
    }
    const keys = new Set(f.rows.map((r) => r.key));
    for (const r of f.rows) {
      const prevIdx = lastSeen.get(r.key);
      if (prevIdx !== undefined && prevIdx < i - 1 && prevIdx >= i - 6) {
        out.flashes++; if (out.log.length < 12) out.log.push(`#${i} ${r.key} reappeared after ${i - prevIdx - 1} frames`);
      }
      lastSeen.set(r.key, i);
    }
    if (i > 0) {
      const prev = frames[i - 1];
      const scrollDelta = f.st - prev.st;
      for (const r of f.rows) {
        const p = prev.rows.find((x) => x.key === r.key);
        if (!p) continue;
        // On-screen movement not explained by the scroll offset change.
        // A jump moves a row on screen in a way the scroll offset does not
        // explain (a prepend compensated by scrollTop keeps it still on
        // screen; a plain scroll moves it by exactly the offset change).
        const screen = r.top - p.top;
        const content = screen + scrollDelta;
        if (Math.abs(screen) > 2 && Math.abs(content) > 2 && Math.abs(r.h - p.h) < 2) {
          out.jumps++; if (out.log.length < 12) out.log.push(`#${i} ${r.key} moved ${screen}px on screen (scroll ${scrollDelta})`);
        }
      }
    }
    void keys;
  }
  return out;
}
