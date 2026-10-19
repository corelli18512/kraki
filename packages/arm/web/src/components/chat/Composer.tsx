import { useTranslation } from 'react-i18next';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, CornerRightUp, ImagePlus, Square, X, CircleX } from 'lucide-react';
import type { Attachment } from '@kraki/protocol';
import { useStore } from '../../hooks/useStore';
import { enterSendsMessage, shouldAutoFocusTextInput } from '../../lib/mobile-input';
import { MicButton, VoiceError, VoiceRow, VoiceTranscript, useDictation, useStartDictation } from './Voice';
import { finishDictation, voiceSettings, type VoiceFinish } from '../../lib/voice/voice';
import { sessionContext } from '../../lib/voice/context';
import type { PendingInput } from '../../lib/chat/outbox';
import { mergeVoiceDraft, stagedVoice } from '../../lib/voice/staged-input';

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

/** Only Pi's ask_user takes images with the answer (Mac ComposerAnswerImages). */
export function answerImagesAllowed(agent: string | undefined): boolean {
  return agent?.toLowerCase() === 'pi';
}

export type ComposerIntent = 'prompt' | 'steer' | 'answerQuestion' | 'denyPermission';

/** iOS/Mac `MessageComposerPolicy`: a waiting permission turns the composer
 *  into its deny reason, an open question into its answer field; a running
 *  turn makes sends steer it. */
export function composerIntent(isBusy: boolean, hasQuestion: boolean, hasPermission = false): ComposerIntent {
  if (hasPermission) return 'denyPermission';
  if (hasQuestion) return 'answerQuestion';
  return isBusy ? 'steer' : 'prompt';
}

const PLACEHOLDER = {
  prompt: 'composer.placeholder.prompt',
  steer: 'composer.placeholder.steer',
  answerQuestion: 'composer.placeholder.answerQuestion',
  denyPermission: 'composer.placeholder.denyPermission',
} as const;

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
  editStaged: (entry: PendingInput) => boolean;
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
  /** The session's agent: decides whether an answer may carry an image. */
  agent?: string;
  onSend: (text: string, attachments: Attachment[] | undefined, intent: ComposerIntent) => void;
  /** Dispatch Stop. Call `onRefused` if it could not be sent. */
  onAbort: (onRefused: () => void) => void;
  onStageVoice?: (text: string, attachments: Attachment[] | undefined, intent: ComposerIntent) => string;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { sessionId, intent, canAbort, reachable, busy, agent, onSend, onAbort, onStageVoice },
  ref,
) {
  const { t } = useTranslation('chat');
  const text = useStore((s) => s.drafts.get(sessionId) ?? '');
  const setDraft = useStore((s) => s.setDraft);
  const [image, setImage] = useState<{ attachment: Attachment; preview: string } | null>(null);
  // Images in an answer (Mac ComposerAnswerImages): only Pi's questions take
  // them, image-only answers included. For other agents attach is off while
  // answering and a staged image stays in the composer for a later message.
  const answering = intent === 'answerQuestion';
  const answerTakesImage = answering && answerImagesAllowed(agent);
  const canAttach = answering ? answerTakesImage : intent !== 'denyPermission' && !busy;
  const carriesImage = intent === 'denyPermission' ? false : answering ? answerTakesImage : true;
  const [abortPending, setAbortPending] = useState(false);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const [multiline, setMultiline] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const dictation = useDictation(sessionId);

  const onVoiceFinal = (spoken: string, mode: VoiceFinish) => {
    const draft = useStore.getState().drafts.get(sessionId) ?? '';
    const full = mergeVoiceDraft(draft, spoken);
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
  }, onVoiceFinal, onStageVoice && intent !== 'denyPermission' ? (raw) => {
    const base = useStore.getState().drafts.get(sessionId) ?? '';
    const sent = carriesImage ? image : null;
    const id = onStageVoice(mergeVoiceDraft(base, raw), sent ? [sent.attachment] : undefined, intent);
    setDraft(sessionId, '');
    if (sent) setImage(null);
    setTimeout(() => fieldRef.current?.focus(), 0);
    return stagedVoice(id, base, !!sent, (original) => {
      const current = useStore.getState().drafts.get(sessionId) ?? '';
      setDraft(sessionId, current.trim() ? `${original}\n${current}` : original);
    });
  } : undefined);

  useImperativeHandle(ref, () => ({
    focus: () => fieldRef.current?.focus(),
    editStaged: (entry) => {
      const attachments = entry.attachments ?? [];
      if (attachments.length > 1 || (attachments.length && image)) return false;
      const attachment = attachments[0];
      if (attachment && attachment.type !== 'image') return false;
      if (attachment?.type === 'image') setImage({ attachment, preview: `data:${attachment.mimeType};base64,${attachment.data}` });
      setDraft(sessionId, mergeVoiceDraft(useStore.getState().drafts.get(sessionId) ?? '', entry.originalText ?? entry.text));
      fieldRef.current?.focus();
      return true;
    },
  }), [sessionId, image, setDraft]);

  // A new session (or the turn ending) resets the pending abort.
  useEffect(() => { setAbortPending(false); }, [sessionId, canAbort]);
  // Like native ComposerLatchSettling: going offline drops any unacked Stop
  // (it is connection-scoped), and a new trailing error is how the Tentacle
  // reports a failed abort while the turn stays active. Either way Stop must
  // become actionable again instead of spinning forever.
  const trailingError = useStore((s) => {
    const list = s.messages.get(sessionId);
    const last = list?.[list.length - 1];
    return last?.type === 'error' ? last : null;
  });
  useEffect(() => { if (!reachable) setAbortPending(false); }, [reachable]);
  useEffect(() => { if (trailingError) setAbortPending(false); }, [trailingError]);
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
  const canSend = hasText || (!!image && carriesImage);
  const showsStop = canAbort && !hasText && !image;

  const submit = useCallback(() => {
    if (!canSend) return;
    const trimmed = text.trim();
    const sent = carriesImage ? image : null;
    onSend(trimmed || '[image]', sent ? [sent.attachment] : undefined, intent);
    setDraft(sessionId, '');
    if (sent) setImage(null);
  }, [canSend, text, image, carriesImage, intent, onSend, setDraft, sessionId]);

  const primary = () => {
    if (dictation.active) { if (dictation.phase !== 'finishing') finishDictation(intent === 'denyPermission' ? 'edit' : 'send'); return; }
    if (showsStop) {
      if (abortPending || !reachable) return;
      setAbortPending(true);
      const pendingFor = sessionId;
      onAbort(() => { if (currentSession.current === pendingFor) setAbortPending(false); });
    } else {
      submit();
    }
  };

  const pickImage = async (file: File | undefined) => {
    if (!canAttach || !file || !file.type.startsWith('image/')) return;
    const result = await compressImage(file);
    if (result) setImage(result);
    else useStore.getState().setLastError(t('composer.imageTooLarge'));
  };

  const voiceSend = dictation.active;
  const glyph = voiceSend ? 'send' : showsStop ? 'stop' : intent === 'steer' ? 'steer' : 'send';
  const label = voiceSend ? t('composer.sendDictation') : showsStop ? t('composer.stop')
    : intent === 'answerQuestion' ? t('composer.submitAnswer')
    : intent === 'denyPermission' ? t('composer.denyReason')
    : intent === 'steer' ? t('composer.steer') : t('composer.send');

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
          aria-label={image ? t('composer.replaceImage') : t('composer.attachImage')}
          disabled={!canAttach}
          onClick={() => fileRef.current?.click()}
        >
          {image ? <img src={image.preview} alt={t('composer.attached')} /> : <ImagePlus aria-hidden />}
        </button>
        {image && (
          <button type="button" className="kcomposer-unattach" disabled={!canAttach} aria-label={t('composer.removeImage')} onClick={() => setImage(null)}>
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
          placeholder={t(PLACEHOLDER[intent])}
          aria-label={t(PLACEHOLDER[intent])}
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
            if (!enterSendsMessage()) return;
            e.preventDefault();
            submit();
          }}
        />
        </div>
        {(hasText || image) && <button type="button" className="kcomposer-clear" aria-label={t('composer.clear')} onClick={() => {
          setDraft(sessionId, ''); setImage(null); fieldRef.current?.focus();
        }}><CircleX aria-hidden /></button>}
        <MicButton owner={sessionId} onStart={startVoice} disabled={!reachable} />
        </>)}
      </div>
      <button
        type="button"
        className={`kprimary is-${glyph} ${!voiceSend && !showsStop && !canSend ? 'is-disabled' : ''} ${!voiceSend && showsStop && !reachable ? 'is-unreachable' : ''} ${canSend && !reachable ? 'is-offline' : ''}`}
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
