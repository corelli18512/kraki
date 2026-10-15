import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { WindowsTitleBar } from './WindowsTitleBar';

const bridge = vi.hoisted(() => ({ hasWindowsTitleBar: true, desktop: { titleBarOverlay: { setTheme: vi.fn() } } }));
vi.mock('../../lib/desktop', () => bridge);
beforeEach(() => { bridge.hasWindowsTitleBar = true; bridge.desktop.titleBarOverlay.setTheme.mockClear(); });
afterEach(() => { cleanup(); document.documentElement.classList.remove('dark'); });

describe('WindowsTitleBar shell lifecycle', () => {
  it('owns the no-session/setup drag strip and tracks app theme without remounting', async () => {
    const { container, unmount } = render(<WindowsTitleBar />);
    expect(container.querySelector('.kwindows-titlebar')).toHaveAttribute('aria-hidden', 'true');
    expect(document.documentElement).toHaveAttribute('data-windows-titlebar');
    expect(bridge.desktop.titleBarOverlay.setTheme).toHaveBeenLastCalledWith('light');
    document.documentElement.classList.add('dark');
    await waitFor(() => expect(bridge.desktop.titleBarOverlay.setTheme).toHaveBeenLastCalledWith('dark'));
    unmount();
    expect(document.documentElement).not.toHaveAttribute('data-windows-titlebar');
    const calls = bridge.desktop.titleBarOverlay.setTheme.mock.calls.length;
    document.documentElement.classList.remove('dark');
    await Promise.resolve();
    expect(bridge.desktop.titleBarOverlay.setTheme).toHaveBeenCalledTimes(calls);
  });

  it('does nothing in browsers, Linux and older Electron shells', () => {
    bridge.hasWindowsTitleBar = false;
    const { container } = render(<WindowsTitleBar />);
    expect(container).toBeEmptyDOMElement();
    expect(document.documentElement).not.toHaveAttribute('data-windows-titlebar');
    expect(bridge.desktop.titleBarOverlay.setTheme).not.toHaveBeenCalled();
  });
});

describe('Windows titlebar CSS source contracts (not native hit-testing proof)', () => {
  const css = readFileSync('src/components/desktop/windows-titlebar.css', 'utf8');
  it('uses live native geometry instead of fixed caption button widths and gates every rule', () => {
    expect(css).toContain('env(titlebar-area-width, calc(100vw - 138px))');
    expect(css).toContain('env(titlebar-area-x, 0px)');
    expect(css).toContain('env(titlebar-area-height, 44px)');
    expect(css).toContain('@media (display-mode: fullscreen)');
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((rule) => rule.trim()).filter(Boolean);
    for (const rule of rules) expect(rule).toContain('html[data-windows-titlebar]');
  });

  it('keeps only blank regions draggable, protects overlay controls and reserves no-session/report space', () => {
    expect(css).toContain('-webkit-app-region: drag');
    expect(css).toContain('-webkit-app-region: no-drag');
    expect(css).toContain('[role="menu"], [role="dialog"], [role="alertdialog"]');
    expect(css).toContain(':is([role="dialog"], [role="alertdialog"]).fixed');
    expect(css).toContain('.app-viewport > main:not(:has(.khead.is-windows))');
    expect(css).toContain(':has(.khead.is-windows) .kwindows-titlebar { display: none; }');
    expect(css).toContain('.kreport-panel { padding-top: var(--windows-titlebar-height); }');
    expect(css).toContain('--windows-header-space: calc(100vw - 280px - var(--windows-caption-width));');
    expect(css).toContain('min-width: 24px;');
    expect(css).toContain('.khead-windows-popup .khead-menu');
    expect(css).toContain('left: clamp(8px, var(--windows-mode-left),');
    expect(css).toContain('width: min(238px, calc(100vw - 16px));');
    expect(css).toContain('border-radius: 4px;');
    expect(css).toContain('background: transparent;');
    expect(css).toContain('box-shadow: none;');
  });
});
