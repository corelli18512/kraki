import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { i18next } from '../../i18n';
import qrcode from 'qrcode-generator';
import { QrScanner, decodeQrFrame } from './QrScanner';

afterEach(async () => { await i18next.changeLanguage('en'); vi.unstubAllGlobals(); });

describe('QrScanner localization', () => {
  it('updates camera errors live without requesting the camera again', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
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
    expect(instruction.parentElement).toHaveTextContent('将相机对准 kraki connect 生成的二维码');
  });
});

describe('QrScanner camera errors (K-239)', () => {
  it('a missing camera is not reported as denied access', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new DOMException('none', 'NotFoundError')) } });
    render(<QrScanner onScan={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText('No camera found. Connect a camera, or open the pairing link on this device instead.');
    expect(screen.queryByText(/Camera access denied/)).not.toBeInTheDocument();
  });

  it('a page without mediaDevices (plain http) reports no camera instead of crashing into denied', async () => {
    vi.stubGlobal('navigator', {});
    render(<QrScanner onScan={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText('No camera found. Connect a camera, or open the pairing link on this device instead.');
  });

  it('a camera in use elsewhere says the camera could not start', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new DOMException('busy', 'NotReadableError')) } });
    render(<QrScanner onScan={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText('Couldn’t start the camera. Close other apps using it and try again.');
  });
});

/** Render a QR code to RGBA pixels, dark-on-light or inverted. */
function qrPixels(text: string, inverted: boolean) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const scale = 4;
  const quiet = 4;
  const modules = qr.getModuleCount();
  const size = (modules + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const my = Math.floor(y / scale) - quiet;
      const dark = mx >= 0 && my >= 0 && mx < modules && my < modules && qr.isDark(my, mx);
      const v = dark !== inverted ? 0 : 255;
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, size };
}

describe('QrScanner decoding (K-108)', () => {
  const link = 'https://app.kraki.chat/?relay=wss%3A%2F%2Frelay.kraki.chat&token=pt_inverted';
  it('decodes a normal dark-on-light code', () => {
    const { data, size } = qrPixels(link, false);
    expect(decodeQrFrame(data, size, size)).toBe(link);
  });
  it('decodes an inverted light-on-dark code', () => {
    const { data, size } = qrPixels(link, true);
    expect(decodeQrFrame(data, size, size)).toBe(link);
  });
});
