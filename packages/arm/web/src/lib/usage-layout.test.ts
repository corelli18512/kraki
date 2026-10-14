import { describe, expect, it } from 'vitest';
import { detailUsageLayout } from './usage-layout';

describe('detailUsageLayout (UsagePeekLayout)', () => {
  it('weights the 2/1/1 ring fixture, including comfort and native rounding', () => {
    expect(detailUsageLayout([2, 1, 1])).toEqual({ rows: [[0, 1, 2]], widths: [273, 224, 224], width: 782.16 });
  });
  it('minimizes the widest ordered row, preserving the native tie-break', () => {
    expect(detailUsageLayout([2, 1, 1, 2])).toEqual({ rows: [[0, 1], [2, 3]], widths: [273, 224, 224, 273], width: 545.96 });
  });
  it('fits narrow viewports without overgrowing single cards or empty state', () => {
    const plan = detailUsageLayout([2, 1], 220);
    expect(plan).toEqual({ rows: [[0], [1]], widths: [184, 184], width: 220 });
    expect(detailUsageLayout([])).toEqual({ rows: [], widths: [], width: 420 });
    expect(detailUsageLayout([], 220).width).toBe(220);
  });
});
