import { afterEach, describe, expect, it } from 'vitest';
import { supportsLinks, termLink } from '../term-link.js';

describe('supportsLinks (K-269)', () => {
  it('turns links off in a TTY without a known OSC 8 terminal (Linux console, xterm, Terminal.app)', () => {
    expect(supportsLinks({ TERM: 'linux' }, true)).toBe(false);
    expect(supportsLinks({ TERM: 'xterm-256color' }, true)).toBe(false);
    expect(supportsLinks({ TERM_PROGRAM: 'Apple_Terminal' }, true)).toBe(false);
  });

  it('keeps links in terminals that render OSC 8', () => {
    expect(supportsLinks({ TERM_PROGRAM: 'iTerm.app' }, true)).toBe(true);
    expect(supportsLinks({ TERM_PROGRAM: 'vscode' }, true)).toBe(true);
    expect(supportsLinks({ WT_SESSION: 'x' }, true)).toBe(true);
    expect(supportsLinks({ VTE_VERSION: '7600' }, true)).toBe(true);
    expect(supportsLinks({ KITTY_WINDOW_ID: '1' }, true)).toBe(true);
  });

  it('never emits links when stdout is not a TTY, unless forced', () => {
    expect(supportsLinks({ TERM_PROGRAM: 'iTerm.app' }, false)).toBe(false);
    expect(supportsLinks({ FORCE_HYPERLINK: '1' }, false)).toBe(true);
    expect(supportsLinks({ FORCE_HYPERLINK: '0', TERM_PROGRAM: 'iTerm.app' }, true)).toBe(false);
  });
});

describe('termLink', () => {
  const originalEnv = { ...process.env };
  const originalIsTTY = process.stdout.isTTY;
  afterEach(() => {
    process.env = { ...originalEnv };
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  it('shows the URL in a plain xterm TTY instead of an invisible OSC 8 link (K-269)', () => {
    for (const key of ['FORCE_HYPERLINK', 'WT_SESSION', 'TERM_PROGRAM', 'KITTY_WINDOW_ID', 'KONSOLE_VERSION', 'VTE_VERSION']) delete process.env[key];
    process.env.TERM = 'xterm-256color';
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    expect(termLink('how to install', 'https://example.com/install')).toBe('how to install: https://example.com/install');
  });

  it('prints the URL next to the text when links are off', () => {
    process.env.FORCE_HYPERLINK = '0';
    expect(termLink('how to install', 'https://example.com/install')).toBe('how to install: https://example.com/install');
  });
});
