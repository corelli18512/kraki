/**
 * "Connect your phone" — Kraki for Mac's PairingSheet: one glass card with the
 * QR code, one line of instructions and a quiet "Copy link". The code renews
 * itself before it expires; when a phone (or browser) joins while the card is
 * open it turns into a check mark and closes on its own.
 *
 * Open it by dispatching `kraki:connect-phone` on window.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Check, CircleCheck, Link, TriangleAlert, X } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import { desktop } from '../../lib/desktop';
import './connect-phone.css';

export const CONNECT_PHONE_EVENT = 'kraki:connect-phone';

function QrSvg({ text }: { text: string }) {
  const path = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return { d, n };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${path.n} ${path.n}`} width="184" height="184" shapeRendering="crispEdges" aria-label="Pairing QR code">
      <path d={path.d} fill="#000" />
    </svg>
  );
}

function Card({ onClose }: { onClose: () => void }) {
  const devices = useStore((s) => s.devices);
  const myDeviceId = useStore((s) => s.deviceId);
  const [payload, setPayload] = useState<{ url: string; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState<string | null>(null);

  const onlineApps = useMemo(
    () => [...devices.values()].filter((d) => d.role === 'app' && d.online && d.id !== myDeviceId),
    [devices, myDeviceId],
  );
  const baseline = useRef<Set<string> | null>(null);
  if (baseline.current === null) baseline.current = new Set(onlineApps.map((d) => d.id));

  // Anything that joins while the card is open is "the phone".
  useEffect(() => {
    if (connected) return;
    const joined = onlineApps.find((d) => !baseline.current!.has(d.id));
    if (!joined) return;
    setConnected(joined.name);
    const t = setTimeout(onClose, 2200);
    return () => clearTimeout(t);
  }, [onlineApps, connected, onClose]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCopied(false);
    const r = await desktop?.builtIn?.connectPhone();
    if (r?.ok && r.url) {
      setPayload({ url: r.url, expiresAt: r.expiresAt ? Date.parse(r.expiresAt) : Date.now() + 5 * 60_000 });
    } else {
      setError(r?.error === 'daemon_not_running'
        ? 'Kraki isn’t running on this PC. Turn on “Run agents on this PC” in Settings, then try again.'
        : 'Couldn’t get a code from the relay. Check your connection and try again.');
    }
    setLoading(false);
  }, []);

  // Fetch a code, and a fresh one shortly before each expires.
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!payload || connected) return;
    const wait = Math.max(5_000, payload.expiresAt - Date.now() - 10_000);
    const t = setTimeout(() => { void load(); }, wait);
    return () => clearTimeout(t);
  }, [payload, connected, load]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  return (
    <div className="cp-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cp-card" role="dialog" aria-modal="true" aria-label="Connect your phone" data-testid="connect-phone">
        <button type="button" className="cp-close" onClick={onClose} title="Close (Esc)" aria-label="Close"><X strokeWidth={3.2} /></button>
        {connected ? (
          <div className="cp-success">
            <CircleCheck className="cp-success-icon" />
            <div className="cp-title">Connected</div>
            <div className="cp-detail">{connected} can now see and run your sessions.</div>
          </div>
        ) : (
          <div className="cp-content">
            <div className="cp-head">
              <div className="cp-title">Connect your phone</div>
              <div className="cp-detail">Scan with your phone’s camera. Your sessions show up there — no sign-in needed.</div>
            </div>
            <div className="cp-qr">
              {payload && <div className={loading ? 'cp-qr-code cp-dim' : 'cp-qr-code'}><QrSvg text={payload.url} /></div>}
              {loading && <span className="cp-spinner" />}
              {!loading && error && (
                <div className="cp-error">
                  <TriangleAlert className="cp-error-icon" />
                  <button type="button" className="cp-retry" onClick={() => { void load(); }}>Try again</button>
                </div>
              )}
            </div>
            {error ? (
              <div className="cp-error-text">{error}</div>
            ) : (
              <div className="cp-footer">
                <span className="cp-waiting"><span className="cp-spinner cp-spinner-mini" />Waiting for your phone</span>
                <button
                  type="button"
                  className="cp-copy"
                  disabled={!payload}
                  title={payload?.url}
                  onClick={() => { if (payload) { void navigator.clipboard.writeText(payload.url); setCopied(true); } }}
                >
                  {copied ? <Check /> : <Link />}{copied ? 'Copied' : 'Copy link'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Mount once; shows the card while open. */
export function ConnectPhoneHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(CONNECT_PHONE_EVENT, show);
    return () => window.removeEventListener(CONNECT_PHONE_EVENT, show);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  if (!open || !desktop?.builtIn) return null;
  return <Card onClose={close} />;
}
