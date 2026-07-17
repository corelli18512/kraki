import { describe, expect, it } from 'vitest';
import { canonicalArtifactToolName } from '../adapters/tool-name.js';

describe('canonicalArtifactToolName', () => {
  it.each([
    ['show_image', undefined, undefined, 'show_image'],
    ['kraki-show_image', undefined, undefined, 'show_image'],
    ['mcp__kraki__show_image', undefined, undefined, 'show_image'],
    ['show_html', undefined, undefined, 'show_html'],
    ['kraki-show_html', undefined, undefined, 'show_html'],
    ['mcp__kraki__show_html', undefined, undefined, 'show_html'],
    ['view', 'kraki', 'show_image', 'show_image'],
    ['tool', 'kraki', 'show_html', 'show_html'],
  ])('normalizes %s / %s / %s to %s', (name, server, tool, expected) => {
    expect(canonicalArtifactToolName(name, server, tool)).toBe(expected);
  });

  it.each([
    ['my_show_image_wrapper', undefined, undefined],
    ['show_image', 'other', 'show_image'],
    ['view', 'kraki', 'other'],
    ['bash', undefined, undefined],
  ])('does not normalize unrelated identity %s / %s / %s', (name, server, tool) => {
    expect(canonicalArtifactToolName(name, server, tool)).toBe(name);
  });
});
