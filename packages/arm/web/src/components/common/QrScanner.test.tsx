import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { i18next } from '../../i18n';
import { QrScanner } from './QrScanner';

afterEach(async () => { await i18next.changeLanguage('en'); vi.unstubAllGlobals(); });

describe('QrScanner localization', () => {
  it('updates camera errors live without requesting the camera again', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    render(<QrScanner onScan={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText('Camera access denied. Check your browser or device settings.');
    await act(async () => { await i18next.changeLanguage('zh-Hans'); });
    expect(screen.getByText('无法访问相机。请检查浏览器或设备设置。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回' })).toBeInTheDocument();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('keeps the command in the localized scanning instruction unchanged', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise(() => {}) } });
    await i18next.changeLanguage('zh-Hans');
    render(<QrScanner onScan={vi.fn()} onClose={vi.fn()} />);
    const instruction = screen.getByText('kraki connect');
    expect(instruction.tagName).toBe('CODE');
    expect(instruction.parentElement).toHaveTextContent('对准 kraki connect 生成的二维码');
  });
});
