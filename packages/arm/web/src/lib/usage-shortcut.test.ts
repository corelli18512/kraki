import { beforeEach, describe, expect, it } from 'vitest';
import { matchesUsageShortcut, setUsageShortcut, shortcutFromEvent, useUsageShortcut } from './usage-shortcut';
beforeEach(() => { useUsageShortcut.setState({ shortcut: 'F6', enabled: true, recording: false }); });
describe('usage shortcut preferences', () => {
  it('accepts F1–F20 and modified keys but rejects bare letters/modifiers', () => {
    expect(shortcutFromEvent(new KeyboardEvent('keydown', { key: 'F20' }))).toBe('F20');
    expect(shortcutFromEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+A');
    for (const key of ['a', 'Control', 'Alt', 'F21', 'Escape']) expect(shortcutFromEvent(new KeyboardEvent('keydown', { key }))).toBeNull();
  });
  it('persists and honors configured keys rather than F6; disabled/recording never activate', () => {
    setUsageShortcut('Alt+A', true);
    expect(localStorage.getItem('kraki:usage.shortcut')).toBe('Alt+A');
    expect(matchesUsageShortcut(new KeyboardEvent('keydown', { key: 'F6' }))).toBe(false);
    expect(matchesUsageShortcut(new KeyboardEvent('keydown', { key: 'a', altKey: true }))).toBe(true);
    useUsageShortcut.setState({ recording: true });
    expect(matchesUsageShortcut(new KeyboardEvent('keydown', { key: 'a', altKey: true }))).toBe(false);
    setUsageShortcut('F8', false);
    expect(matchesUsageShortcut(new KeyboardEvent('keydown', { key: 'F8' }))).toBe(false);
  });
});
