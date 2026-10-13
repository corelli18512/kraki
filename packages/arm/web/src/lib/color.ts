import macAgentPalette from './mac-agent-palette.json';

/** Deterministic color from a string — same input always produces same hue. */
export function stringToHue(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** MacBubbleContent uses AppKit calibrated HSB, not CSS's sRGB HSL.
 * Generated with NSColor(calibratedHue: …).usingColorSpace(.sRGB) for every
 * integer stringToHue seed, with native light (.40/.93) and dark (.35/.18) S/L.
 * Keep this conversion table separate from avatar colors. */
export function agentBubbleColors(seed: string): { light: string; dark: string } {
  const hue = stringToHue(seed);
  return { light: macAgentPalette.light[hue], dark: macAgentPalette.dark[hue] };
}
