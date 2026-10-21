/**
 * "Connect your phone" — Kraki for Mac's PairingSheet: one glass card with the
 * QR code, one line of instructions and a quiet "Copy link". The code renews
 * itself before it expires; when a phone (or browser) joins while the card is
 * open it turns into a check mark and closes on its own.
 *
 * Open it by dispatching `kraki:connect-phone` on window.
 */
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Check, CircleCheck, Link, TriangleAlert, X } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import { desktop } from '../../lib/desktop';
import './connect-phone.css';

export const CONNECT_PHONE_EVENT = 'kraki:connect-phone';

function QrSvg({ text }: { text: string }) {
  const { t } = useTranslation('devices');
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
    <svg viewBox={`0 0 ${path.n} ${path.n}`} width="184" height="184" shapeRendering="crispEdges" aria-label={t('connectPhone.qr')}>
      <path d={path.d} fill="#000" />
    </svg>
  );
}

function Card({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('devices');
  const devices = useStore((s) => s.devices);
  const myDeviceId = useStore((s) => s.deviceId);
  const [payload, setPayload] = useState<{ url: string; expiresAt: number } | null>(null);
  const [error, setError] = useState<'notRunning' | 'relayError' | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

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
    if (joined) setConnected(joined.name);
  }, [onlineApps, connected]);

  // Close on its own once connected. Its own effect: later device-list
  // updates must not cancel the timer.
  useEffect(() => {
    if (!connected) return;
    const t = setTimeout(onClose, 2200);
    return () => clearTimeout(t);
  }, [connected, onClose]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCopied(false);
    const r = await desktop?.builtIn?.connectPhone();
    if (r?.ok && r.url) {
      setPayload({ url: r.url, expiresAt: r.expiresAt ? Date.parse(r.expiresAt) : Date.now() + 5 * 60_000 });
    } else {
      setError(r?.error === 'daemon_not_running'
        ? 'notRunning'
        : 'relayError');
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
    const card = cardRef.current;
    if (!card) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusFirst = () => (card.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? card).focus();
    focusFirst();
    // Pairing is a sibling of Settings. Capture its keys before the underlying
    // Settings window, and contain focus even while loading/replacing controls.
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      } else if (event.key === 'Tab') {
        event.stopImmediatePropagation();
        const controls = card.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        const first = controls[0];
        const last = controls[controls.length - 1];
        const outside = !card.contains(document.activeElement) || document.activeElement === card;
        if (event.shiftKey ? outside || document.activeElement === first : outside || document.activeElement === last) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !card.contains(event.target)) focusFirst();
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('focusin', containFocus, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('focusin', containFocus, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [onClose]);

  useEffect(() => {
    // Removing the focused Retry/Copy button can leave focus on document.body
    // without a focusin event. Keep the foreground sheet's remaining Close reachable.
    const card = cardRef.current;
    if (card && !card.contains(document.activeElement)) card.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [loading, error, connected]);

  return (
    <div className="cp-backdrop" onMouseDown={(e) => {
      if (e.target === e.currentTarget) {
        e.preventDefault(); // Do not let backdrop mouse focus undo the restored opener.
        onClose();
      }
    }}>
      <div ref={cardRef} tabIndex={-1} className="cp-card" role="dialog" aria-modal="true" aria-label={t('connectPhone.title')} data-testid="connect-phone">
        <button type="button" className="cp-close" onClick={onClose} title={t('connectPhone.closeShortcut')} aria-label={t('connectPhone.close')}><X strokeWidth={3.2} /></button>
        {connected ? (
          <div className="cp-success">
            <CircleCheck className="cp-success-icon" />
            <div className="cp-title">{t('connectPhone.connected')}</div>
            <div className="cp-detail">{t('connectPhone.connectedDetail', { name: connected })}</div>
          </div>
        ) : (
          <div className="cp-content">
            <div className="cp-head">
              <div className="cp-title">{t('connectPhone.title')}</div>
              <div className="cp-detail">{t('connectPhone.detail')}</div>
            </div>
            <div className="cp-qr">
              {payload && <div className={loading ? 'cp-qr-code cp-dim' : 'cp-qr-code'}><QrSvg text={payload.url} /></div>}
              {loading && <span className="cp-spinner" />}
              {!loading && error && (
                <div className="cp-error">
                  <TriangleAlert className="cp-error-icon" />
                  <button type="button" className="cp-retry" onClick={() => { void load(); }}>{t('connectPhone.tryAgain')}</button>
                </div>
              )}
            </div>
            {error ? (
              <div className="cp-error-text">{t(`connectPhone.${error}`)}</div>
            ) : (
              <div className="cp-footer">
                <span className="cp-waiting"><span className="cp-spinner cp-spinner-mini" />{t('connectPhone.waiting')}</span>
                <button
                  type="button"
                  className="cp-copy"
                  disabled={!payload}
                  title={payload?.url}
                  onClick={() => { if (payload) { void navigator.clipboard.writeText(payload.url); setCopied(true); } }}
                >
                  {copied ? <Check /> : <Link />}{copied ? t('connectPhone.copied') : t('connectPhone.copy')}
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
