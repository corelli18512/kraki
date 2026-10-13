import { describe, expect, it } from 'vitest';
import { metadataNeedsSecondRow, sessionMetadataFrames } from './SessionCardMetadata';

describe('SessionCardMetadata (SessionMetadataLayout)', () => {
  it('wraps exactly past device + 1 + min(model,40) + effort + 6pt gaps', () => {
    expect(metadataNeedsSecondRow(69, 16, 80, 0)).toBe(false);
    expect(metadataNeedsSecondRow(68, 16, 80, 0)).toBe(true);
    expect(metadataNeedsSecondRow(95, 16, 80, 20)).toBe(false);
    expect(metadataNeedsSecondRow(94, 16, 80, 20)).toBe(true);
    expect(metadataNeedsSecondRow(20, 0, 80, 20)).toBe(false);
    expect(metadataNeedsSecondRow(20, 16, 0, 20)).toBe(false);
  });
  it('protects device and effort widths and gives the remainder to a head-truncated model', () => {
    const { frames, height, showSeparator } = sessionMetadataFrames(210, 50, 180, 20);
    expect(frames.device.width).toBe(50);
    expect(frames.model.left).toBe(63);
    expect(frames.model.width).toBe(121);
    expect(frames.effort.left).toBe(190);
    expect(frames.effort.width).toBe(20);
    expect(height).toBe(15);
    expect(showSeparator).toBe(true);
  });
  it('places model/effort on a second row without a separator for long devices', () => {
    const { frames, height, showSeparator } = sessionMetadataFrames(210, 190, 180, 20);
    expect(frames.device.width).toBe(190);
    expect(frames.model.left).toBe(0);
    expect(frames.model.top).toBe(14);
    expect(frames.model.width).toBe(180);
    expect(frames.effort.left).toBe(186);
    expect(frames.effort.top).toBe(14);
    expect(height).toBe(26);
    expect(showSeparator).toBe(false);
  });
  it('puts effort on its own row at exceptionally narrow proposals and never returns negative widths', () => {
    const { frames, height } = sessionMetadataFrames(20, 10, 80, 30);
    expect(frames.device.width).toBe(10);
    expect(frames.model.width).toBe(20);
    expect(frames.model.top).toBe(14);
    expect(frames.effort.left).toBe(0);
    expect(frames.effort.width).toBe(20);
    expect(frames.effort.top).toBe(28);
    expect(height).toBe(40);
    expect(sessionMetadataFrames(0, 10, 80, 30).frames.model.width).toBe(0);
  });
});
