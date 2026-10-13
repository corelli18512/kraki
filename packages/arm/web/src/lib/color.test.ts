import { describe, expect, it } from 'vitest';
import { agentBubbleColors, agentNavigationColors, stringToHue } from './color';
import palette from './mac-agent-palette.json';

describe('agentNavigationColors — MacChatScrollView template-button tint', () => {
  it('uses the native session hue with separate light/dark saturation and lightness', () => {
    expect(stringToHue('mv23g6gx-gq3i4yy8')).toBe(95);
    expect(agentNavigationColors('mv23g6gx-gq3i4yy8')).toEqual({ light: 'hsl(95 70% 45%)', dark: 'hsl(95 75% 65%)' });
    expect(agentNavigationColors('mv6hxl3c-v9oii65w')).toEqual({ light: 'hsl(78 70% 45%)', dark: 'hsl(78 75% 65%)' });
    // Paired Chromium/native glyph pixels agree within one channel level.
    expect(agentNavigationColors('s')).not.toEqual(agentBubbleColors('s'));
  });
});

describe('agentBubbleColors — AppKit calibrated HSB to sRGB', () => {
  it('covers every hue in both native appearances', () => {
    for (const colors of [palette.light, palette.dark]) {
      expect(colors).toHaveLength(360);
      for (const color of colors) expect(color).toMatch(/^#[a-f0-9]{6}$/);
    }
  });
  it('uses the short reference session hue without changing the hash', () => {
    expect(stringToHue('mv6hxl3c-v9oii65w')).toBe(78);
    expect(agentBubbleColors('mv6hxl3c-v9oii65w')).toEqual({ light: '#f3f6eb', dark: '#444e28' });
  });
  it('matches native calibration at each primary/secondary hue (light and dark)', () => {
    expect([0, 60, 120, 180, 240, 300].map((h) => palette.light[h]))
      .toEqual(['#f7ebeb', '#f6f6eb', '#ebf6eb', '#ebf6f7', '#ebebf7', '#f7ecf6']);
    expect([0, 60, 120, 180, 240, 300].map((h) => palette.dark[h]))
      .toEqual(['#502928', '#4f4e28', '#264e28', '#264f4f', '#282a4f', '#502b4f']);
  });
});
