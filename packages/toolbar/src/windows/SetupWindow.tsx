import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import QRCode from 'qrcode';

const OFFICIAL_RELAY = 'wss://kraki.corelli.cloud';

// GitHub OAuth device flow constants
const GITHUB_CLIENT_ID = 'Ov23liUYbFrJfBWR0uRo';

type Step = 'auth' | 'device-name' | 'creating' | 'pairing' | 'done';

interface DeviceCodeData {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export default function SetupWindow() {
  const [step, setStep] = useState<Step>('auth');
  const [error, setError] = useState<string | null>(null);

  // Auth state
  const [deviceCode, setDeviceCode] = useState<DeviceCodeData | null>(null);
  const [authPolling, setAuthPolling] = useState(false);
  const [githubToken, setGithubToken] = useState<string | null>(null);
  const [githubUser, setGithubUser] = useState<string | null>(null);

  // Device name state
  const [deviceName, setDeviceName] = useState('');

  // Pairing state
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [pairingUrl, setPairingUrl] = useState<string | null>(null);
  const [pairingSecondsLeft, setPairingSecondsLeft] = useState(300);

  // Pre-fill device name from hostname
  useEffect(() => {
    const name = navigator.userAgent.includes('Mac') ? 'Mac' : 'Desktop';
    setDeviceName(name);
  }, []);

  // ── Step 1: GitHub Device Flow ──────────────────────────

  const startGitHubAuth = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: 'read:user' }),
      });
      if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
      const data = (await res.json()) as DeviceCodeData;
      setDeviceCode(data);
      setAuthPolling(true);
    } catch (err) {
      setError(`Failed to start GitHub login: ${(err as Error).message}`);
    }
  }, []);

  // Poll for token approval
  useEffect(() => {
    if (!authPolling || !deviceCode) return;

    const interval = (deviceCode.interval ?? 5) * 1000;
    const deadline = Date.now() + deviceCode.expires_in * 1000;

    const timer = setInterval(async () => {
      if (Date.now() > deadline) {
        clearInterval(timer);
        setAuthPolling(false);
        setError('Authorization timed out. Please try again.');
        return;
      }

      try {
        const res = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            client_id: GITHUB_CLIENT_ID,
            device_code: deviceCode.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
        });
        const data = (await res.json()) as Record<string, string>;

        if (data.access_token) {
          clearInterval(timer);
          setAuthPolling(false);
          setGithubToken(data.access_token);

          try {
            const userRes = await fetch('https://api.github.com/user', {
              headers: { Authorization: `Bearer ${data.access_token}`, 'User-Agent': 'kraki-toolbar' },
            });
            const userData = (await userRes.json()) as Record<string, unknown>;
            setGithubUser(String(userData.login ?? 'unknown'));
          } catch { /* ignore */ }

          setStep('device-name');
        } else if (data.error === 'expired_token') {
          clearInterval(timer);
          setAuthPolling(false);
          setError('Code expired. Please try again.');
        } else if (data.error === 'access_denied') {
          clearInterval(timer);
          setAuthPolling(false);
          setError('Authorization denied.');
        }
      } catch { /* network error — keep trying */ }
    }, interval);

    return () => clearInterval(timer);
  }, [authPolling, deviceCode]);

  // ── Step 2: Create config + start daemon ────────────────

  const finishSetup = useCallback(async () => {
    setStep('creating');
    setError(null);
    try {
      await invoke('run_headless_setup', {
        relay: OFFICIAL_RELAY,
        authMethod: 'github_token',
        deviceName: deviceName.trim() || 'Desktop',
        githubToken,
      });

      await invoke('start_daemon');
      await new Promise((r) => setTimeout(r, 3000));

      try {
        const url = await invoke<string>('get_pairing_url');
        setPairingUrl(url);
        const dataUrl = await QRCode.toDataURL(url, {
          width: 200,
          margin: 2,
          color: { dark: '#1a1a1a', light: '#ffffff' },
        });
        setQrDataUrl(dataUrl);
        setStep('pairing');
      } catch {
        setStep('done');
      }
    } catch (err) {
      setError(`Setup failed: ${err}`);
      setStep('device-name');
    }
  }, [deviceName, githubToken]);

  // ── Pairing countdown ───────────────────────────────────

  useEffect(() => {
    if (step !== 'pairing') return;
    if (pairingSecondsLeft <= 0) {
      setStep('done');
      return;
    }
    const id = setTimeout(() => setPairingSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [step, pairingSecondsLeft]);

  const closeSelf = () => getCurrentWindow().close();

  // ── Render ──────────────────────────────────────────────

  return (
    <div className="relative flex flex-col items-center justify-center min-h-screen bg-white px-8 select-none">
      {/* Authenticating overlay */}
      {step === 'creating' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/80">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#ea6046] border-t-transparent" />
            <p className="text-sm text-gray-500">Setting up Kraki…</p>
          </div>
        </div>
      )}

      {/* ── Auth step (matches web login) ─────────────── */}
      {(step === 'auth' || step === 'creating') && !deviceCode && (
        <>
          <img src="/logo.png" alt="Kraki" className="h-28 w-28 object-contain mb-4" />
          <h2 className="text-lg font-semibold text-gray-900">Welcome to Kraki</h2>
          <p className="mt-2 max-w-xs text-sm text-gray-500 text-center">
            Sign in to connect to your coding agent sessions.
          </p>

          {error && (
            <p className="mt-4 text-xs text-red-500 text-center max-w-xs">{error}</p>
          )}

          <button
            onClick={startGitHubAuth}
            className="mt-6 inline-flex cursor-pointer items-center gap-2 rounded-lg bg-[#24292f] px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[#32383f]"
          >
            <GitHubMark className="h-5 w-5" />
            Sign in with GitHub
          </button>

          <p className="mt-8 rounded-lg bg-gray-50 px-4 py-2 font-mono text-xs text-gray-400">
            {OFFICIAL_RELAY}
          </p>
        </>
      )}

      {/* ── Auth step: device code shown ──────────────── */}
      {step === 'auth' && deviceCode && (
        <>
          <img src="/logo.png" alt="Kraki" className="h-28 w-28 object-contain mb-4" />
          <h2 className="text-lg font-semibold text-gray-900">Enter code on GitHub</h2>
          <div className="mt-4 font-mono text-2xl font-bold tracking-widest text-gray-900 bg-gray-50 px-6 py-3 rounded-lg border border-gray-200">
            {deviceCode.user_code}
          </div>
          <a
            href={deviceCode.verification_uri}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded-lg bg-[#24292f] px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[#32383f]"
          >
            <GitHubMark className="h-5 w-5" />
            Open GitHub
          </a>
          {authPolling && (
            <p className="mt-4 text-xs text-gray-400 animate-pulse">Waiting for authorization…</p>
          )}
          {error && (
            <p className="mt-4 text-xs text-red-500 text-center max-w-xs">{error}</p>
          )}
        </>
      )}

      {/* ── Device name step ──────────────────────────── */}
      {step === 'device-name' && (
        <>
          <img src="/logo.png" alt="Kraki" className="h-28 w-28 object-contain mb-4" />
          {githubUser && (
            <p className="text-sm text-green-600 mb-2">
              ✓ Signed in as <span className="font-medium">{githubUser}</span>
            </p>
          )}
          <h2 className="text-lg font-semibold text-gray-900">Name this machine</h2>
          <p className="mt-2 max-w-xs text-sm text-gray-500 text-center">
            This helps you identify it when multiple machines are connected.
          </p>

          {error && (
            <p className="mt-3 text-xs text-red-500 text-center max-w-xs">{error}</p>
          )}

          <input
            type="text"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            placeholder="e.g. MacBook Pro"
            className="mt-5 w-64 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#ea6046]/50 focus:border-[#ea6046]"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') finishSetup();
            }}
          />
          <button
            onClick={finishSetup}
            className="mt-4 w-64 py-2.5 px-4 bg-[#ea6046] text-white text-sm font-medium rounded-lg hover:bg-[#d9533a] transition-colors cursor-pointer"
          >
            Continue
          </button>
        </>
      )}

      {/* ── QR Pairing step ───────────────────────────── */}
      {step === 'pairing' && (
        <>
          <p className="text-sm text-green-600 font-medium mb-2">✓ Kraki is running</p>
          <h2 className="text-lg font-semibold text-gray-900">Connect your phone</h2>
          <p className="mt-2 max-w-xs text-sm text-gray-500 text-center">
            Scan this code to open the Kraki web app on your phone.
          </p>
          {qrDataUrl && (
            <img
              src={qrDataUrl}
              alt="Pairing QR code"
              width={200}
              height={200}
              className="mt-4 rounded-lg border border-gray-100"
            />
          )}
          <p className="mt-3 text-xs text-gray-400">
            Expires in {Math.floor(pairingSecondsLeft / 60)}:{(pairingSecondsLeft % 60).toString().padStart(2, '0')}
          </p>
          {pairingUrl && (
            <a
              href={pairingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 text-xs text-blue-500 hover:underline"
            >
              Open in browser
            </a>
          )}
          <button
            onClick={closeSelf}
            className="mt-5 text-sm text-gray-400 hover:text-gray-600 cursor-pointer"
          >
            Skip — I'll pair later
          </button>
        </>
      )}

      {/* ── Done ──────────────────────────────────────── */}
      {step === 'done' && (
        <>
          <img src="/logo.png" alt="Kraki" className="h-28 w-28 object-contain mb-4" />
          <p className="text-sm text-green-600 font-medium">✓ Setup complete</p>
          <p className="mt-2 max-w-xs text-sm text-gray-500 text-center">
            Kraki is running in your menu bar. Use the tray icon to pair devices later.
          </p>
          <button
            onClick={closeSelf}
            className="mt-6 py-2.5 px-8 bg-[#24292f] text-white text-sm font-medium rounded-lg hover:bg-[#32383f] transition-colors cursor-pointer"
          >
            Done
          </button>
        </>
      )}
    </div>
  );
}
