import { useEffect, useRef, useState, useCallback } from 'react';
import { X } from 'lucide-react';
import jsQR from 'jsqr';

interface QrScannerProps {
  onScan: (url: string) => void;
  onClose: () => void;
}

/**
 * Fullscreen camera overlay that decodes QR codes containing a Kraki pairing URL.
 * Uses getUserMedia for the camera feed and jsQR for decoding.
 */
export function QrScanner({ onScan, onClose }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stopCamera = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
  }, []);

  const handleClose = useCallback(() => {
    stopCamera();
    onClose();
  }, [stopCamera, onClose]);

  useEffect(() => {
    let mounted = true;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (!mounted) { for (const t of stream.getTracks()) t.stop(); return; }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        scan();
      } catch {
        if (mounted) setError('Camera access denied. Check your browser or device settings.');
      }
    }

    function scan() {
      if (!mounted) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2) {
        rafRef.current = requestAnimationFrame(scan);
        return;
      }

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });

      if (code?.data) {
        try {
          const url = new URL(code.data);
          const token = url.searchParams.get('token');
          const relay = url.searchParams.get('relay');
          if (token && relay) {
            onScan(code.data);
            return; // Stop scanning — parent will close us
          }
        } catch {
          // Not a valid URL — keep scanning
        }
      }

      rafRef.current = requestAnimationFrame(scan);
    }

    start();
    return () => { mounted = false; stopCamera(); };
  }, [onScan, stopCamera]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/95">
      {/* Close button */}
      <button
        onClick={handleClose}
        className="absolute right-4 top-4 z-10 rounded-full bg-white/10 p-2 text-white/80 backdrop-blur-sm transition-colors hover:bg-white/20"
      >
        <X className="h-5 w-5" />
      </button>

      {error ? (
        <div className="px-8 text-center">
          <p className="text-sm text-white/80">{error}</p>
          <button
            onClick={handleClose}
            className="mt-4 rounded-lg bg-white/10 px-4 py-2 text-sm text-white/80 transition-colors hover:bg-white/20"
          >
            Go back
          </button>
        </div>
      ) : (
        <>
          {/* Viewfinder */}
          <div className="relative overflow-hidden rounded-2xl border-2 border-white/20" style={{ width: 'min(80vw, 320px)', height: 'min(80vw, 320px)' }}>
            <video
              ref={videoRef}
              playsInline
              muted
              className="h-full w-full object-cover"
            />
            {/* Corner accents */}
            <div className="pointer-events-none absolute inset-0">
              <div className="absolute left-0 top-0 h-8 w-8 border-l-2 border-t-2 border-white/60 rounded-tl-lg" />
              <div className="absolute right-0 top-0 h-8 w-8 border-r-2 border-t-2 border-white/60 rounded-tr-lg" />
              <div className="absolute bottom-0 left-0 h-8 w-8 border-b-2 border-l-2 border-white/60 rounded-bl-lg" />
              <div className="absolute bottom-0 right-0 h-8 w-8 border-b-2 border-r-2 border-white/60 rounded-br-lg" />
            </div>
            {/* Scan line animation */}
            <div className="pointer-events-none absolute inset-x-0 h-0.5 bg-kraki-400/60 animate-scan-line" />
          </div>

          <p className="mt-6 text-sm text-white/60">
            Point at the QR code from <code className="rounded bg-white/10 px-1.5 py-0.5">kraki connect</code>
          </p>
        </>
      )}

      {/* Hidden canvas for frame capture */}
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
