import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import QRCode from 'qrcode';

const OFFICIAL_RELAY = 'wss://kraki.corelli.cloud';

// GitHub OAuth device flow constants
const GITHUB_CLIENT_ID = 'Ov23liUYbFrJfBWR0uRo';
const POLL_INTERVAL_MS = 5000;

type Step = 'auth' | 'device-name' | 'creating' | 'pairing' | 'done';

interface DeviceCodeData {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
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

          // Fetch username
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
        // 'authorization_pending' — keep polling
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

      // Start daemon
      await invoke('start_daemon');

      // Wait for daemon to start and connect
      await new Promise((r) => setTimeout(r, 3000));

      // Get pairing URL
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
        // Pairing failed but setup succeeded — close
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
    <div className="flex flex-col items-center min-h-screen bg-white px-8 py-10 select-none">
      {/* Logo */}
      <div className="text-3xl mb-1">🦑</div>
      <h1 className="text-lg font-bold text-gray-900 mb-1">Set up Kraki</h1>

      {/* Step indicator */}
      <div className="flex gap-2 mb-6">
        {(['auth', 'device-name', 'pairing'] as const).map((s, i) => (
          <div
            key={s}
            className={`w-2 h-2 rounded-full ${
              step === s || (step === 'creating' && s === 'device-name')
                ? 'bg-orange-500'
                : step === 'done' || i < ['auth', 'device-name', 'pairing'].indexOf(step)
                  ? 'bg-green-400'
                  : 'bg-gray-200'
            }`}
          />
        ))}
      </div>

      {error && (
        <p className="text-xs text-red-500 text-center mb-4 max-w-xs">{error}</p>
      )}

      {/* ── Step 1: GitHub Auth ───────────────────────────── */}
      {step === 'auth' && !deviceCode && (
        <div className="flex flex-col items-center gap-4 w-full max-w-xs">
          <p className="text-sm text-gray-600 text-center">
            Sign in with GitHub to connect your agent sessions.
          </p>
          <button
            onClick={startGitHubAuth}
            className="w-full py-2.5 px-4 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800 transition-colors"
          >
            Sign in with GitHub
          </button>
        </div>
      )}

      {step === 'auth' && deviceCode && (
        <div className="flex flex-col items-center gap-3 w-full max-w-xs">
          <p className="text-sm text-gray-600 text-center">
            Enter this code on GitHub:
          </p>
          <div className="font-mono text-2xl font-bold tracking-widest text-gray-900 bg-gray-50 px-6 py-3 rounded-lg border">
            {deviceCode.user_code}
          </div>
          <a
            href={deviceCode.verification_uri}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-500 hover:underline"
          >
            Open GitHub →
          </a>
          {authPolling && (
            <p className="text-xs text-gray-400 animate-pulse">Waiting for authorization…</p>
          )}
        </div>
      )}

      {/* ── Step 2: Device Name ───────────────────────────── */}
      {step === 'device-name' && (
        <div className="flex flex-col items-center gap-4 w-full max-w-xs">
          {githubUser && (
            <p className="text-sm text-green-600">
              ✓ Signed in as <span className="font-medium">{githubUser}</span>
            </p>
          )}
          <p className="text-sm text-gray-600 text-center">
            Name this machine so you can identify it later.
          </p>
          <input
            type="text"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            placeholder="e.g. MacBook Pro"
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') finishSetup();
            }}
          />
          <button
            onClick={finishSetup}
            className="w-full py-2.5 px-4 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600 transition-colors"
          >
            Continue
          </button>
        </div>
      )}

      {/* ── Step 3: Creating ─────────────────────────────── */}
      {step === 'creating' && (
        <div className="flex flex-col items-center gap-3">
          <div className="w-6 h-6 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-500">Setting up Kraki…</p>
        </div>
      )}

      {/* ── Step 4: QR Pairing ───────────────────────────── */}
      {step === 'pairing' && (
        <div className="flex flex-col items-center gap-3 w-full max-w-xs">
          <p className="text-sm text-green-600 font-medium">✓ Kraki is running</p>
          <p className="text-sm text-gray-600 text-center">
            Scan with your phone to connect the web app.
          </p>
          {qrDataUrl && (
            <img
              src={qrDataUrl}
              alt="Pairing QR code"
              width={200}
              height={200}
              className="rounded-lg border border-gray-100"
            />
          )}
          <p className="text-xs text-gray-400">
            Expires in {Math.floor(pairingSecondsLeft / 60)}:{(pairingSecondsLeft % 60).toString().padStart(2, '0')}
          </p>
          {pairingUrl && (
            <a
              href={pairingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-500 hover:underline"
            >
              Open in browser
            </a>
          )}
          <button
            onClick={closeSelf}
            className="mt-2 text-sm text-gray-400 hover:text-gray-600"
          >
            Skip — I'll pair later
          </button>
        </div>
      )}

      {/* ── Done ─────────────────────────────────────────── */}
      {step === 'done' && (
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm text-green-600 font-medium">✓ Setup complete</p>
          <p className="text-sm text-gray-500 text-center">
            Kraki is running in your menu bar. Use the tray icon to pair devices later.
          </p>
          <button
            onClick={closeSelf}
            className="mt-2 py-2 px-6 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800 transition-colors"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}
