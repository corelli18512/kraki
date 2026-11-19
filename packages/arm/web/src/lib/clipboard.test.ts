import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const originalExecCommand = document.execCommand;

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value });
}

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
  document.execCommand = originalExecCommand;
});

describe('copyText (K-215)', () => {
  it('uses the Clipboard API when it is there', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    document.execCommand = vi.fn(() => true);
    await expect(copyText('abc')).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith('abc');
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it('copies through a selection without the Clipboard API (plain-http relay)', async () => {
    setClipboard(undefined);
    let selected = '';
    document.execCommand = vi.fn(() => { selected = (document.activeElement as HTMLTextAreaElement).value; return true; });
    await expect(copyText('session-1')).resolves.toBeUndefined();
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(selected).toBe('session-1');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back when the Clipboard API refuses', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('NotAllowed')) });
    document.execCommand = vi.fn(() => true);
    await expect(copyText('x')).resolves.toBeUndefined();
    expect(document.execCommand).toHaveBeenCalledWith('copy');
  });

  it('rejects when nothing can copy, instead of throwing in the click handler', async () => {
    setClipboard({ writeText: () => { throw new TypeError('no'); } });
    document.execCommand = vi.fn(() => false);
    await expect(copyText('x')).rejects.toThrow();
  });
});
