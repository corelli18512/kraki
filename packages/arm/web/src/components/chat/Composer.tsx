import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, CornerRightUp, ImagePlus, Square, X, CircleX } from 'lucide-react';
import type { Attachment } from '@kraki/protocol';
import { useStore } from '../../hooks/useStore';
import { shouldAutoFocusTextInput } from '../../lib/mobile-input';
import { MicButton, VoiceError, VoiceRow, VoiceTranscript, useDictation, useStartDictation } from './Voice';
import { finishDictation, voiceSettings, type VoiceFinish } from '../../lib/voice/voice';
import { sessionContext } from '../../lib/voice/context';

/** Text worth mining for spelling terms (never sent whole). */
function messageText(m: unknown): string {
  const p = (m as { payload?: { content?: unknown; text?: unknown } }).payload;
  const v = p?.content ?? p?.text;
  return typeof v === 'string' ? v : '';
}

/** Native editor edge fades only when content is hidden beyond that edge. */
export function updateComposerScrollFade(el: HTMLTextAreaElement): void {
  const top = el.scrollTop > 0.5;
  const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 0.5;
  el.style.maskImage = top || bottom
    ? `linear-gradient(to bottom, ${top ? 'transparent' : '#000'}, #000 14px, #000 calc(100% - 14px), ${bottom ? 'transparent' : '#000'})`
    : '';
}
const MAX_IMAGE_SIZE = 3 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1024;

export type ComposerIntent = 'prompt' | 'steer' | 'answerQuestion' | 'denyPermission';

/** iOS/Mac `MessageComposerPolicy`: a waiting permission turns the composer
 *  into its deny reason, an open question into its answer field; a running
 *  turn makes sends steer it. */
export function composerIntent(isBusy: boolean, hasQuestion: boolean, hasPermission = false): ComposerIntent {
  if (hasPermission) return 'denyPermission';
  if (hasQuestion) return 'answerQuestion';
  return isBusy ? 'steer' : 'prompt';
}

const PLACEHOLDER: Record<ComposerIntent, string> = {
  prompt: 'Send a message…',
  steer: 'Steer the agent…',
  answerQuestion: 'Type your answer…',
  denyPermission: 'Deny with reason…',
};

async function compressImage(file: File): Promise<{ attachment: Attachment; preview: string } | null> {
  const img = new window.Image();
  const url = URL.createObjectURL(file);
  img.src = url;
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; }).catch(() => null);
  URL.revokeObjectURL(url);
  let { width, height } = img;
  if (!width || !height) return null;
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    const scale = MAX_IMAGE_DIMENSION / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
  for (const [type, quality] of [[file.type || 'image/jpeg', 0.8], ['image/jpeg', 0.6]] as const) {
    const dataUrl = canvas.toDataURL(type, quality);
    const data = dataUrl.split(',')[1];
    if (Math.ceil((data.length * 3) / 4) <= MAX_IMAGE_SIZE) {
      return { attachment: { type: 'image', mimeType: dataUrl.substring(5, dataUrl.indexOf(';')), data }, preview: dataUrl };
    }
  }
  return null;
}

export interface ComposerHandle {
  focus: () => void;
}

export interface ComposerProps {
  sessionId: string;
  intent: ComposerIntent;
  /** The turn can be stopped (running / compacting / live card). */
  canAbort: boolean;
  /** Relay up and the session's device online. */
  reachable: boolean;
  /** Attachments are unavailable during a running or compacting turn. */
  busy: boolean;
  onSend: (text: string, attachments: Attachment[] | undefined, intent: ComposerIntent) => void;
  onAbort: () => void;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { sessionId, intent, canAbort, reachable, busy, onSend, onAbort },
  ref,
) {
  const text = useStore((s) => s.drafts.get(sessionId) ?? '');
  const setDraft = useStore((s) => s.setDraft);
  const [image, setImage] = useState<{ attachment: Attachment; preview: string } | null>(null);
  const [abortPending, setAbortPending] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const [multiline, setMultiline] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const dictation = useDictation(sessionId);

  const onVoiceFinal = (spoken: string, mode: VoiceFinish) => {
    const draft = useStore.getState().drafts.get(sessionId) ?? '';
    const full = [draft.trimEnd(), spoken].filter(Boolean).join(draft && !/\s$/.test(draft) ? ' ' : '');
    if (mode === 'send' && full.trim()) {
      onSend(full.trim(), undefined, intent);
      setDraft(sessionId, '');
    } else {
      setDraft(sessionId, full);
      setTimeout(() => fieldRef.current?.focus(), 0);
    }
  };
  const startVoice = useStartDictation(sessionId, () => {
    const st = useStore.getState();
    const session = st.sessions.get(sessionId);
    const recent = (st.messages.get(sessionId) ?? []).slice(-12).map(messageText).filter(Boolean);
    return sessionContext(
      { id: sessionId, title: session?.title ?? session?.autoTitle ?? undefined, agent: session?.agent ?? 'agent', model: session?.model ?? undefined, mode: st.sessionModes.get(sessionId) },
      recent, [], voiceSettings.shareContext,
    );
  }, onVoiceFinal);

  useImperativeHandle(ref, () => ({ focus: () => fieldRef.current?.focus() }), []);

  // A new session (or the turn ending) resets the pending abort.
  useEffect(() => { setAbortPending(false); }, [sessionId, canAbort]);
  useEffect(() => { setImage(null); }, [sessionId]);

  useEffect(() => {
    if (shouldAutoFocusTextInput()) fieldRef.current?.focus({ preventScroll: true });
  }, [sessionId]);

  // Measure wrapping at the one-row width even when the controls are stacked.
  // The editor stays mounted so wrapping never loses focus, selection or IME.
  useLayoutEffect(() => {
    const el = fieldRef.current;
    const box = boxRef.current;
    if (!el || !box) return;
    const fit = () => {
      const desktop = window.matchMedia('(min-width: 768px)').matches;
      const micWidth = box.querySelector('.kmic') ? (desktop ? 32 : 44) : 0;
      const clearWidth = desktop && (text.trim() || image) ? 26 : 0;
      el.style.width = `${Math.max(1, box.clientWidth - (desktop ? 5 : 0) - 44 - clearWidth - micWidth)}px`;
      el.style.padding = desktop ? '1px 4px' : '14px 16px 14px 4px';
      el.style.height = '0px';
      const cs = getComputedStyle(el);
      const line = parseFloat(cs.lineHeight) || 20;
      const padding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const stacked = !!text.trim() && (text.includes('\n') || el.scrollHeight > line + padding + 0.5);
      setMultiline(stacked);
      el.style.padding = '';
      if (desktop) el.style.width = `${Math.max(1, box.clientWidth - 5 - (stacked ? 12 : 44 + (text.trim() || image ? 26 : 0) + (box.querySelector('.kmic') ? 32 : 0)))}px`;
      if (!desktop) el.style.width = '';
      const fittedPadding = desktop ? padding : stacked ? 17 : 28;
      el.style.height = `${Math.min(Math.max(el.scrollHeight, line + fittedPadding), desktop ? 3 * line + padding : 168)}px`;
      el.style.width = '';
      updateComposerScrollFade(el);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [text, image, multiline, dictation.active]);

  const hasText = text.trim().length > 0;
  const structured = intent === 'answerQuestion' || intent === 'denyPermission';
  const canSend = structured ? hasText : hasText || !!image;
  const showsStop = canAbort && !hasText && !image;

  const submit = useCallback(() => {
    if (!canSend) return;
    const trimmed = text.trim();
    onSend(trimmed || '[image]', image ? [image.attachment] : undefined, intent);
    setDraft(sessionId, '');
    setImage(null);
  }, [canSend, text, image, intent, onSend, setDraft, sessionId]);

  const primary = () => {
    if (dictation.active) { if (dictation.phase !== 'finishing') finishDictation('send'); return; }
    if (showsStop) {
      if (abortPending || !reachable) return;
      setAbortPending(true);
      onAbort();
    } else {
      submit();
    }
  };

  const pickImage = async (file: File | undefined) => {
    if (busy || !file || !file.type.startsWith('image/')) return;
    const result = await compressImage(file);
    if (result) setImage(result);
    else useStore.getState().setLastError('Image is too large (max 3 MB after compression).');
  };

  const voiceSend = dictation.active;
  const glyph = voiceSend ? 'send' : showsStop ? 'stop' : intent === 'steer' ? 'steer' : 'send';
  const label = voiceSend ? 'Send dictation' : showsStop ? 'Stop agent'
    : intent === 'answerQuestion' ? 'Submit answer'
    : intent === 'denyPermission' ? 'Deny with reason'
    : intent === 'steer' ? 'Steer agent' : 'Send message';

  return (
    <div className="kcomposer">
      <VoiceError owner={sessionId} />
      <div ref={boxRef} className={`kcomposer-field${multiline && !dictation.active ? ' is-multiline' : ''}${dictation.active ? ' is-dictating' : ''}`}>
        {dictation.active ? (
          <>
            <VoiceTranscript owner={sessionId} />
            <VoiceRow owner={sessionId} />
          </>
        ) : (<>
        <button
          type="button"
          className={`kcomposer-attach ${image ? 'has-image' : ''}`}
          aria-label={image ? 'Replace image' : 'Attach image'}
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {image ? <img src={image.preview} alt="Attached" /> : <ImagePlus aria-hidden />}
        </button>
        {image && (
          <button type="button" className="kcomposer-unattach" aria-label="Remove image" onClick={() => setImage(null)}>
            <X aria-hidden />
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => { void pickImage(e.target.files?.[0]); e.target.value = ''; }}
        />
        <div className="kcomposer-text">
        <textarea
          ref={fieldRef}
          rows={1}
          value={text}
          placeholder={PLACEHOLDER[intent]}
          aria-label={PLACEHOLDER[intent]}
          onChange={(e) => setDraft(sessionId, e.target.value)}
          onScroll={(e) => updateComposerScrollFade(e.currentTarget)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onPaste={(e) => {
            const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
            if (file) { e.preventDefault(); void pickImage(file); }
          }}
          onKeyDown={(e) => {
            // Enter sends on a keyboard; Shift+Enter (or a touch keyboard's
            // return) inserts a newline. Never while an IME is composing.
            if (e.key !== 'Enter' || e.shiftKey || composing.current || e.nativeEvent.isComposing) return;
            if (!shouldAutoFocusTextInput()) return;
            e.preventDefault();
            submit();
          }}
        />
        </div>
        {(hasText || image) && <button type="button" className="kcomposer-clear" aria-label="Clear draft" onClick={() => {
          setDraft(sessionId, ''); setImage(null); fieldRef.current?.focus();
        }}><CircleX aria-hidden /></button>}
        <MicButton owner={sessionId} onStart={startVoice} disabled={!reachable} />
        </>)}
      </div>
      <button
        type="button"
        className={`kprimary is-${glyph} ${!voiceSend && !showsStop && !canSend ? 'is-disabled' : ''} ${!voiceSend && showsStop && !reachable ? 'is-unreachable' : ''}`}
        aria-label={label}
        data-testid={voiceSend ? 'voice-send' : showsStop ? 'chat-stop' : 'chat-send'}
        onClick={primary}
        disabled={voiceSend ? dictation.phase === 'finishing' : showsStop ? abortPending || !reachable : !canSend}
      >
        {!voiceSend && showsStop
          ? abortPending ? <span className="kspinner is-light" aria-hidden /> : <Square className="kprimary-stop" aria-hidden />
          : glyph === 'steer' ? <CornerRightUp aria-hidden /> : <ArrowUp aria-hidden />}
      </button>
    </div>
  );
});
