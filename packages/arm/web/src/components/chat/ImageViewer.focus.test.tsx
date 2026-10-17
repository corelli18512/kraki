/** F8 desired invariants; browser replay uses the same real tile/provider/Composer path. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImagePreviewProvider } from './ImageViewer';
import { ImageAttachments } from './Attachments';
import { Composer } from './Composer';
import { useStore } from '../../hooks/useStore';
import { UsagePanel } from '../usage/UsagePanel';
import { useUsageShortcut } from '../../lib/usage-shortcut';

const sessionId = 'image-focus';
function fixture({ strict = false, usage = false } = {}) {
  const onSend = vi.fn();
  const content = <MemoryRouter><ImagePreviewProvider>
    <ImageAttachments attachments={[{ type: 'image', mimeType: 'image/png', data: 'AA==' }]} />
    <Composer sessionId={sessionId} intent="prompt" reachable canAbort={false} busy={false} onSend={onSend} onAbort={vi.fn()} />
  </ImagePreviewProvider>{usage && <UsagePanel />}</MemoryRouter>;
  const view = render(strict ? <StrictMode>{content}</StrictMode> : content);
  return { ...view, onSend, tile: screen.getByRole('button', { name: 'Open image preview', exact: true }) };
}
beforeEach(() => {
  useStore.getState().setDraft(sessionId, 'background action canary');
  useUsageShortcut.setState({ enabled: false, shortcut: 'F6', recording: false });
});

describe('ImageViewer focus', () => {
  for (const strict of [false, true]) it(`${strict ? 'StrictMode: ' : ''}enters the viewer, cycles Tab both ways and contains programmatic focus without background sends`, async () => {
    const user = userEvent.setup();
    const { tile, onSend, container } = fixture({ strict });
    const send = screen.getByRole('button', { name: 'Send message', exact: true });
    const textarea = screen.getByRole('textbox');
    tile.focus(); await user.keyboard('{Enter}');
    const dialog = screen.getByRole('dialog', { name: 'Image preview' });
    const close = screen.getByRole('button', { name: 'Close image preview' });
    expect(dialog).toHaveFocus();
    await user.tab(); expect(screen.getByRole('button', { name: 'Zoom out' })).toHaveFocus();
    await user.tab({ shift: true }); expect(close).toHaveFocus();
    for (let i = 0; i < 12; i++) {
      await user.tab({ shift: i > 5 }); expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    textarea.focus(); await user.keyboard('{Enter}');
    send.focus(); await user.keyboard(' ');
    // Also reject already-targeted key events before the underlying React handler can consume them.
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(container.firstElementChild).toHaveAttribute('inert');
  });

  for (const dismissal of ['toolbar', 'escape', 'canvas']) it(`restores the connected opener on ${dismissal} dismissal`, async () => {
    const user = userEvent.setup();
    const { tile } = fixture();
    tile.focus(); await user.keyboard('{Enter}');
    screen.getByRole('button', { name: 'Zoom in' }).focus();
    if (dismissal === 'toolbar') await user.click(screen.getByRole('button', { name: 'Close image preview' }));
    if (dismissal === 'escape') await user.keyboard('{Escape}');
    if (dismissal === 'canvas') fireEvent.click(document.querySelector('.kimage-canvas')!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(tile).toHaveFocus(); expect(tile.closest('[inert]')).toBeNull();
  });

  it('does not restore on session unmount even while the opener is connected during layout cleanup', async () => {
    const user = userEvent.setup();
    const { tile, unmount } = fixture();
    tile.focus(); await user.keyboard('{Enter}');
    const focus = vi.spyOn(tile, 'focus');
    unmount(); expect(focus).not.toHaveBeenCalled();
    const outside = document.createElement('button'); document.body.append(outside);
    outside.focus(); expect(outside).toHaveFocus(); outside.remove();
  });

  it('removes containment and preserves pre-existing inert state on dismissal', async () => {
    const user = userEvent.setup();
    const sibling = document.createElement('aside'); sibling.setAttribute('inert', ''); document.body.append(sibling);
    const { tile } = fixture(); tile.focus(); await user.keyboard('{Enter}{Escape}');
    expect(sibling).toHaveAttribute('inert'); sibling.remove();
    const field = screen.getByRole('textbox'); field.focus(); expect(field).toHaveFocus();
  });

  it('keeps modal keyboard events, including Escape, away from underlying global actions', async () => {
    const user = userEvent.setup(); const { tile } = fixture();
    tile.focus(); await user.keyboard('{Enter}');
    const underlyingAction = vi.fn();
    window.addEventListener('keydown', underlyingAction);
    try {
      await user.keyboard('x{ArrowRight}{Escape}');
      expect(underlyingAction).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await user.keyboard('x'); expect(underlyingAction).toHaveBeenCalledOnce();
    } finally { window.removeEventListener('keydown', underlyingAction); }
  });

  for (const dismissal of ['toolbar', 'escape', 'canvas']) it(`StrictMode restores the original opener after layout replay and ${dismissal} dismissal`, async () => {
    const user = userEvent.setup(); const { tile } = fixture({ strict: true });
    tile.focus(); await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'Image preview' })).toHaveFocus();
    if (dismissal === 'toolbar') await user.click(screen.getByRole('button', { name: 'Close image preview' }));
    if (dismissal === 'escape') await user.keyboard('{Escape}');
    if (dismissal === 'canvas') fireEvent.click(document.querySelector('.kimage-canvas')!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(tile).toHaveFocus();
  });

  it('StrictMode session unmount does not restore the original opener or retain a trap', async () => {
    const user = userEvent.setup(); const { tile, unmount } = fixture({ strict: true });
    tile.focus(); await user.keyboard('{Enter}');
    const focus = vi.spyOn(tile, 'focus'); unmount(); expect(focus).not.toHaveBeenCalled();
    const outside = document.createElement('button'); document.body.append(outside);
    outside.focus(); expect(outside).toHaveFocus(); outside.remove();
  });

  it('releases an actual enabled UsagePanel peek held before mouse-opening an image', async () => {
    useUsageShortcut.setState({ enabled: true });
    // user-event defaults unknown function keys to code=Unknown; model the real
    // physical code so repeated keydown and keyup describe the same held key.
    const user = userEvent.setup({ keyboardMap: [{ key: 'F6', code: 'F6' }] });
    const { tile, onSend } = fixture({ usage: true });
    await user.keyboard('{F6>}'); expect(screen.getByTestId('usage-panel')).toBeInTheDocument();
    await user.click(tile); expect(screen.getByRole('dialog', { name: 'Image preview' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Image preview' }), { key: 'F6', code: 'F6', repeat: true });
    await user.keyboard('{/F6}{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Image preview' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('usage-panel')).not.toBeInTheDocument());
    expect(tile).toHaveFocus(); expect(onSend).not.toHaveBeenCalled();
  });

  it('does not start Usage shortcuts or Send from modal keys; Usage still works after dismissal', async () => {
    useUsageShortcut.setState({ enabled: true });
    const user = userEvent.setup(); const { tile, onSend } = fixture({ usage: true });
    tile.focus(); await user.keyboard('{Enter}');
    await user.keyboard('{F6>}'); expect(screen.queryByTestId('usage-panel')).not.toBeInTheDocument();
    await user.keyboard('{/F6}{Enter} ');
    expect(screen.queryByTestId('usage-panel')).not.toBeInTheDocument(); expect(onSend).not.toHaveBeenCalled();
    await user.keyboard('{Escape}{F6>}'); expect(screen.getByTestId('usage-panel')).toBeInTheDocument();
    // A release owned by the modal must not schedule Usage's 180ms close and
    // later cancel a genuinely held shortcut immediately after dismissal.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
    expect(screen.getByTestId('usage-panel')).toBeInTheDocument();
    await user.keyboard('{/F6}');
    await waitFor(() => expect(screen.queryByTestId('usage-panel')).not.toBeInTheDocument());
  });

  it('control: nonmodal Composer sends normally', async () => {
    const user = userEvent.setup(); const { onSend } = fixture();
    await user.click(screen.getByRole('button', { name: 'Send message', exact: true }));
    expect(onSend).toHaveBeenCalledWith('background action canary', undefined, 'prompt');
  });
});
