/**
 * Voice input in the composers — Mac/iOS dictation:
 *   mic (in the field) → transcript in the field, then a second row
 *   Cancel · level meter · m:ss · Edit; the round button sends.
 * Send uses the corrected text; Edit puts it in the draft to change first.
 */
import { useEffect, useState } from 'react';
import { Loader2, Mic, TextCursor, X } from 'lucide-react';
import {
  CONSENT_MESSAGE, CONSENT_TITLE, acceptConsent, cancelDictation, declineConsent, dismissVoiceError,
  finishDictation, startDictation, transcriptPieces, useVoice, wordLines, type VoiceFinish,
} from '../../lib/voice/voice';
import type { VoiceContext } from '../../lib/voice/context';
import './chat.css';

/** Dictation state for one composer (`owner` = session id or 'new'). */
export function useDictation(owner: string) {
  const s = useVoice();
  const mine = s.owner === owner;
  return {
    available: !!s.capability,
    active: mine && (s.phase === 'connecting' || s.phase === 'recording' || s.phase === 'finishing'),
    phase: mine ? s.phase : 'idle',
    error: mine && s.phase === 'failed' ? s.error : null,
    levels: mine ? s.levels : [],
    startedAt: mine ? s.startedAt : null,
    pieces: mine ? transcriptPieces(s) : [],
  };
}

/** Start dictating; once the user accepts the cloud notice it starts by itself. */
export function useStartDictation(owner: string, context: () => VoiceContext, onFinal: (text: string, mode: VoiceFinish) => void) {
  const pendingConsent = useVoice((s) => s.consentPending && s.owner === owner);
  const [waiting, setWaiting] = useState(false);
  const start = () => { void startDictation(owner, withWords(context()), onFinal).then((started) => setWaiting(!started)); };
  useEffect(() => {
    if (waiting && !pendingConsent) {
      setWaiting(false);
      if (useVoice.getState().owner === owner) start();
    }
  }, [waiting, pendingConsent]); // eslint-disable-line react-hooks/exhaustive-deps
  return start;
}

/** User words first (Custom Words), then terms from the context. */
function withWords(c: VoiceContext): VoiceContext {
  const words = wordLines();
  return { fields: c.fields, vocabulary: [...words, ...c.vocabulary.filter((v) => !words.includes(v))] };
}

export function MicButton({ owner, onStart, disabled }: { owner: string; onStart: () => void; disabled?: boolean }) {
  const d = useDictation(owner);
  if (!d.available) return null;
  return (
    <button
      type="button"
      className="kmic"
      aria-label="Dictate"
      title="Dictate"
      data-testid="voice-mic"
      disabled={disabled || d.phase === 'finishing'}
      onClick={() => (d.active ? undefined : onStart())}
    >
      {d.phase === 'finishing' ? <Loader2 className="kspin" aria-hidden /> : <Mic aria-hidden />}
    </button>
  );
}

/** The live transcript, replacing the text field while dictating. */
export function VoiceTranscript({ owner }: { owner: string }) {
  const d = useDictation(owner);
  return (
    <div className="kvoice-transcript" data-testid="voice-transcript" aria-live="polite">
      {d.phase === 'recording' && d.pieces.length === 1 && d.pieces[0].opacity < 1 && <span className="kvoice-rec" aria-hidden />}
      {d.pieces.map((p, i) => <span key={i} style={{ opacity: p.opacity }}>{p.text}</span>)}
    </div>
  );
}

function elapsed(from: number | null) {
  const s = from ? Math.max(0, Math.floor((Date.now() - from) / 1000)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Cancel · meter · time · Edit (iOS/Mac recordingControls). */
export function VoiceRow({ owner }: { owner: string }) {
  const d = useDictation(owner);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 500); return () => clearInterval(t); }, []);
  const bars = Array.from({ length: 8 }, (_, i) => d.levels[d.levels.length - 8 + i] ?? 0);
  return (
    <div className="kvoice-row">
      <button type="button" className="kvoice-chip" onClick={cancelDictation} data-testid="voice-cancel"><X aria-hidden />Cancel</button>
      <span className="kvoice-bars" aria-hidden>
        {bars.map((v, i) => {
          const weight = 0.6 + 0.4 * (1 - Math.abs(i - 3.5) / 3.5);
          return <i key={i} style={{ height: 4 + v * weight * 20, opacity: 0.45 + 0.5 * v }} />;
        })}
      </span>
      <span className="kvoice-time">{elapsed(d.startedAt)}</span>
      <span className="kvoice-spacer" />
      <button type="button" className="kvoice-chip is-edit" disabled={d.phase !== 'recording'} onClick={() => finishDictation('edit')} data-testid="voice-edit"><TextCursor aria-hidden />Edit</button>
    </div>
  );
}

export function VoiceError({ owner }: { owner: string }) {
  const d = useDictation(owner);
  if (!d.error) return null;
  return (
    <div className="kvoice-error" role="alert">
      <span>{d.error}</span>
      <button type="button" aria-label="Dismiss" onClick={dismissVoiceError}><X aria-hidden /></button>
    </div>
  );
}

/** One-time notice before the first recording (VoiceConsent). */
export function VoiceConsentHost() {
  const pending = useVoice((s) => s.consentPending);
  useEffect(() => {
    if (!pending) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') declineConsent(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [pending]);
  if (!pending) return null;
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/30 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) declineConsent(); }}>
      <div role="alertdialog" aria-modal="true" aria-label={CONSENT_TITLE} data-testid="voice-consent" className="w-full max-w-md rounded-2xl border border-border-primary bg-surface-primary p-5 shadow-2xl">
        <h3 className="text-[15px] font-semibold text-text-primary">{CONSENT_TITLE}</h3>
        <p className="mt-2 whitespace-pre-line text-[13px] leading-relaxed text-text-secondary">{CONSENT_MESSAGE}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={declineConsent} className="rounded-lg px-3 py-1.5 text-sm text-text-primary hover:bg-surface-secondary">Cancel</button>
          <button type="button" onClick={acceptConsent} className="rounded-lg bg-kraki-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-kraki-600" data-testid="voice-consent-continue">Continue</button>
        </div>
      </div>
    </div>
  );
}
