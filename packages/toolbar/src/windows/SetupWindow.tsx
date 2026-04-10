import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import QRCode from 'qrcode';

// TODO(phase-2): Replace device flow with OAuth redirect flow.
// Register kraki:// deep link, add redirect URI to GitHub OAuth app,
// relay already handles code exchange via github_oauth auth method.
// TODO(phase-2): Add "Advanced" option to enter custom relay URL for self-hosters.

type Step = 'checking' | 'relay-error' | 'auth' | 'auth-polling' | 'device-name' | 'creating' | 'pairing' | 'done';

interface RelayInfo {
  ok: boolean;
  methods?: string[];
  githubClientId?: string | null;
  error?: string;
}

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export default function SetupWindow() {
  const [step, setStep] = useState<Step>('checking');
  const [error, setError] = useState<string | null>(null);

  // Relay state
  const [relayUrl, setRelayUrl] = useState<string>('');
  const [relayInfo, setRelayInfo] = useState<RelayInfo | null>(null);

  // Auth state
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUri, setVerificationUri] = useState<string | null>(null);
  const [githubUser, setGithubUser] = useState<string | null>(null);

  // Device name state
  const [deviceName, setDeviceName] = useState('');

  // Pairing state
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [pairingUrl, setPairingUrl] = useState<string | null>(null);
  const [pairingSecondsLeft, setPairingSecondsLeft] = useState(300);

  // Pre-fill device name
  useEffect(() => {
    const name = navigator.userAgent.includes('Mac') ? 'Mac' : 'Desktop';
    setDeviceName(name);
  }, []);

  // ── Startup: test relay, check auth ─────────────────────

  useEffect(() => {
    (async () => {
      // 0. Get relay URL (from env or default)
      let relay: string;
      try {
        relay = await invoke<string>('get_relay_url');
      } catch {
        relay = 'wss://kraki.corelli.cloud';
      }
      setRelayUrl(relay);
      console.log(`[setup] relay: ${relay}`);

      // 1. Test relay connection and get auth methods
      try {
        const raw = await invoke<string>('run_relay_info', { url: relay });
        const info = JSON.parse(raw) as RelayInfo;
        if (!info.ok) {
          setError(info.error ?? 'Cannot reach relay');
          setStep('relay-error');
          return;
        }
        setRelayInfo(info);
        console.log(`[setup] relay ok — methods: ${info.methods?.join(', ')}, clientId: ${info.githubClientId ?? 'none'}`);
      } catch (err) {
        setError(`Cannot reach relay: ${err}`);
        setStep('relay-error');
        return;
      }

      // 2. Check if gh CLI is already authenticated (same as CLI routine)
      try {
        const result = await invoke<string>('run_doctor');
        const doctor = JSON.parse(result) as { ghAuth: boolean; ghUser: string | null };
        if (doctor.ghAuth) {
          setGithubUser(doctor.ghUser);
          setStep('device-name');
          return;
        }
      } catch { /* doctor failed — continue to manual auth */ }

      setStep('auth');
    })();
  }, []);

  // ── Listen for auth-update events from sidecar ──────────

  useEffect(() => {
    const unlisten = listen<string>('auth-update', (event) => {
      try {
        const data = JSON.parse(event.payload) as Record<string, string>;
        if (data.phase === 'device_code') {
          setUserCode(data.user_code);
          setVerificationUri(data.verification_uri);
          setStep('auth-polling');
        }
      } catch { /* ignore malformed */ }
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // ── Start auth via sidecar ──────────────────────────────

  const startGitHubAuth = useCallback(async () => {
    setError(null);
    const clientId = relayInfo?.githubClientId;
    if (!clientId) {
      setError('Relay does not support GitHub login');
      return;
    }
    try {
      const result = await invoke<string>('start_github_auth', { clientId });
      const data = JSON.parse(result) as { phase: string; username?: string };
      if (data.phase === 'authenticated') {
        setGithubUser(data.username ?? null);
        setStep('device-name');
      }
    } catch (err) {
      setError(`GitHub login failed: ${err}`);
      setStep('auth');
    }
  }, [relayInfo]);

  // ── Retry relay connection ──────────────────────────────

  const retryRelay = useCallback(async () => {
    setError(null);
    setStep('checking');
    try {
      const raw = await invoke<string>('run_relay_info', { url: relayUrl });
      const info = JSON.parse(raw) as RelayInfo;
      if (!info.ok) {
        setError(info.error ?? 'Cannot reach relay');
        setStep('relay-error');
        return;
      }
      setRelayInfo(info);
      setStep('auth');
    } catch (err) {
      setError(`Cannot reach relay: ${err}`);
      setStep('relay-error');
    }
  }, [relayUrl]);

  // ── Finish setup ────────────────────────────────────────

  const finishSetup = useCallback(async () => {
    setStep('creating');
    setError(null);
    try {
      const setupArgs: Record<string, unknown> = {
        relay: relayUrl,
        authMethod: 'github_token',
        deviceName: deviceName.trim() || 'Desktop',
      };
      // Token is read from ~/.kraki/github-token by the sidecar — not passed through the frontend
      await invoke('run_headless_setup', setupArgs);
      await invoke('start_daemon');
      await new Promise((r) => setTimeout(r, 3000));

      try {
        const url = await invoke<string>('get_pairing_url');
        setPairingUrl(url);
        const dataUrl = await QRCode.toDataURL(url, {
          width: 200, margin: 2,
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
  }, [deviceName, relayUrl]);

  // ── Pairing countdown ───────────────────────────────────

  useEffect(() => {
    if (step !== 'pairing') return;
    if (pairingSecondsLeft <= 0) { setStep('done'); return; }
    const id = setTimeout(() => setPairingSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [step, pairingSecondsLeft]);

  const closeSelf = () => {
    const win = getCurrentWindow();
    win.hide().catch(() => win.close().catch(() => {}));
  };

  const openExternal = (url: string) => {
    shellOpen(url).catch(() => { /* ignore */ });
  };

  // ── Render ──────────────────────────────────────────────

  return (
    <div className="relative flex flex-col items-center justify-center min-h-screen bg-white px-8 select-none">
      {/* Creating overlay */}
      {step === 'creating' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/80">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#ea6046] border-t-transparent" />
            <p className="text-sm text-gray-500">Setting up Kraki…</p>
          </div>
        </div>
      )}

      {/* ── Checking ──────────────────────────────────── */}
      {step === 'checking' && (
        <>
          <img src="/logo.png" alt="Kraki" className="h-28 w-28 object-contain mb-4" />
          <div className="flex items-center gap-2">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
            <p className="text-sm text-gray-500">Connecting to relay…</p>
          </div>
        </>
      )}

      {/* ── Relay error ───────────────────────────────── */}
      {step === 'relay-error' && (
        <>
          <img src="/logo.png" alt="Kraki" className="h-28 w-28 object-contain mb-4" />
          <h2 className="text-lg font-semibold text-gray-900">Cannot reach relay</h2>
          {error && (
            <p className="mt-2 text-xs text-red-500 text-center max-w-xs">{error}</p>
          )}
          <button
            onClick={retryRelay}
            className="mt-5 py-2.5 px-6 bg-[#24292f] text-white text-sm font-medium rounded-lg hover:bg-[#32383f] transition-colors cursor-pointer"
          >
            Retry
          </button>
        </>
      )}

      {/* ── Auth: sign in button ──────────────────────── */}
      {step === 'auth' && (
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
        </>
      )}

      {/* ── Auth: device code shown ───────────────────── */}
      {step === 'auth-polling' && (
        <>
          <img src="/logo.png" alt="Kraki" className="h-28 w-28 object-contain mb-4" />
          <h2 className="text-lg font-semibold text-gray-900">Enter code on GitHub</h2>
          {userCode && (
            <div className="mt-4 font-mono text-2xl font-bold tracking-widest text-gray-900 bg-gray-50 px-6 py-3 rounded-lg border border-gray-200">
              {userCode}
            </div>
          )}
          {verificationUri && (
            <button
              onClick={() => openExternal(verificationUri)}
              className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded-lg bg-[#24292f] px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[#32383f]"
            >
              <GitHubMark className="h-5 w-5" />
              Open GitHub
            </button>
          )}
          <p className="mt-4 text-xs text-gray-400 animate-pulse">Waiting for authorization…</p>
        </>
      )}

      {/* ── Device name ───────────────────────────────── */}
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
            onKeyDown={(e) => { if (e.key === 'Enter') finishSetup(); }}
          />
          <button
            onClick={finishSetup}
            className="mt-4 w-64 py-2.5 px-4 bg-[#ea6046] text-white text-sm font-medium rounded-lg hover:bg-[#d9533a] transition-colors cursor-pointer"
          >
            Continue
          </button>
        </>
      )}

      {/* ── QR Pairing ────────────────────────────────── */}
      {step === 'pairing' && (
        <>
          <p className="text-sm text-green-600 font-medium mb-2">✓ Kraki is running</p>
          <h2 className="text-lg font-semibold text-gray-900">Connect your phone</h2>
          <p className="mt-2 max-w-xs text-sm text-gray-500 text-center">
            Scan this code to open the Kraki web app on your phone.
          </p>
          {qrDataUrl && (
            <img src={qrDataUrl} alt="Pairing QR code" width={200} height={200}
              className="mt-4 rounded-lg border border-gray-100" />
          )}
          <p className="mt-3 text-xs text-gray-400">
            Expires in {Math.floor(pairingSecondsLeft / 60)}:{(pairingSecondsLeft % 60).toString().padStart(2, '0')}
          </p>
          {pairingUrl && (
            <button onClick={() => { openExternal(pairingUrl); closeSelf(); }}
              className="mt-1 text-xs text-blue-500 hover:underline cursor-pointer bg-transparent border-none">Open in browser</button>
          )}
          <button onClick={closeSelf}
            className="mt-5 py-2.5 px-8 bg-[#24292f] text-white text-sm font-medium rounded-lg hover:bg-[#32383f] transition-colors cursor-pointer">
            Done
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
          <button onClick={closeSelf}
            className="mt-6 py-2.5 px-8 bg-[#24292f] text-white text-sm font-medium rounded-lg hover:bg-[#32383f] transition-colors cursor-pointer">
            Done
          </button>
        </>
      )}
    </div>
  );
}
