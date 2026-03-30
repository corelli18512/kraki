import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import QRCode from 'qrcode';

const EXPIRY_SECONDS = 300; // 5 minutes — matches relay pairing token TTL

export default function QrWindow() {
  const [url, setUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(EXPIRY_SECONDS);

  useEffect(() => {
    invoke<string>('get_pairing_url')
      .then(async (pairingUrl) => {
        setUrl(pairingUrl);
        const dataUrl = await QRCode.toDataURL(pairingUrl, {
          width: 240,
          margin: 2,
          color: { dark: '#1a1a1a', light: '#ffffff' },
        });
        setQrDataUrl(dataUrl);
      })
      .catch((err: unknown) => {
        setError(String(err));
      });
  }, []);

  // Countdown timer
  useEffect(() => {
    if (secondsLeft <= 0) {
      getCurrentWindow().close();
      return;
    }
    const id = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [secondsLeft]);

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-white p-6 select-none">
      <p className="text-sm font-semibold text-gray-800 mb-1">Pair a new device</p>
      <p className="text-xs text-gray-500 mb-4">Scan with your phone camera</p>

      {error && (
        <p className="text-xs text-red-500 text-center px-4">{error}</p>
      )}

      {qrDataUrl && (
        <img
          src={qrDataUrl}
          alt="Pairing QR code"
          width={240}
          height={240}
          className="rounded-lg border border-gray-100"
        />
      )}

      {!qrDataUrl && !error && (
        <div className="w-60 h-60 bg-gray-100 rounded-lg animate-pulse" />
      )}

      <p className="text-xs text-gray-400 mt-4">
        Expires in {minutes}:{seconds.toString().padStart(2, '0')}
      </p>

      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-500 hover:underline mt-1 truncate max-w-xs"
        >
          Open in browser
        </a>
      )}
    </div>
  );
}
