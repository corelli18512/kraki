import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, CornerRightUp, ImagePlus, Square, X } from 'lucide-react';
import type { Attachment } from '@kraki/protocol';
import { useStore } from '../../hooks/useStore';
import { shouldAutoFocusTextInput } from '../../lib/mobile-input';

const MAX_LINES_HEIGHT = 168;
const MAX_IMAGE_SIZE = 3 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1024;

export type ComposerIntent = 'prompt' | 'steer' | 'answerQuestion';

/** iOS/Mac `MessageComposerPolicy`: an open question turns the composer into
 *  its answer field; a running turn makes sends steer it. */
export function composerIntent(isBusy: boolean, hasQuestion: boolean): ComposerIntent {
  if (hasQuestion) return 'answerQuestion';
  return isBusy ? 'steer' : 'prompt';
}

const PLACEHOLDER: Record<ComposerIntent, string> = {
  prompt: 'Send a message…',
  steer: 'Steer the agent…',
  answerQuestion: 'Type your answer…',
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
  onSend: (text: string, attachments: Attachment[] | undefined, intent: ComposerIntent) => void;
  onAbort: () => void;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { sessionId, intent, canAbort, reachable, onSend, onAbort },
  ref,
) {
  const text = useStore((s) => s.drafts.get(sessionId) ?? '');
  const setDraft = useStore((s) => s.setDraft);
  const [image, setImage] = useState<{ attachment: Attachment; preview: string } | null>(null);
  const [abortPending, setAbortPending] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);

  useImperativeHandle(ref, () => ({ focus: () => fieldRef.current?.focus() }), []);

  // A new session (or the turn ending) resets the pending abort.
  useEffect(() => { setAbortPending(false); }, [sessionId, canAbort]);
  useEffect(() => { setImage(null); }, [sessionId]);

  useEffect(() => {
    if (shouldAutoFocusTextInput()) fieldRef.current?.focus({ preventScroll: true });
  }, [sessionId]);

  // Grow with the text up to a cap, then scroll inside the field.
  useLayoutEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, MAX_LINES_HEIGHT)}px`;
  }, [text]);

  const hasText = text.trim().length > 0;
  const structured = intent === 'answerQuestion';
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
    if (showsStop) {
      if (abortPending || !reachable) return;
      setAbortPending(true);
      onAbort();
    } else {
      submit();
    }
  };

  const pickImage = async (file: File | undefined) => {
    if (!file || !file.type.startsWith('image/')) return;
    const result = await compressImage(file);
    if (result) setImage(result);
    else useStore.getState().setLastError('Image is too large (max 3 MB after compression).');
  };

  const glyph = showsStop ? 'stop' : intent === 'steer' ? 'steer' : 'send';
  const label = showsStop ? 'Stop agent'
    : intent === 'answerQuestion' ? 'Submit answer'
    : intent === 'steer' ? 'Steer agent' : 'Send message';

  return (
    <div className="kcomposer">
      <div className="kcomposer-field">
        <button
          type="button"
          className={`kcomposer-attach ${image ? 'has-image' : ''}`}
          aria-label={image ? 'Replace image' : 'Attach image'}
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
        <textarea
          ref={fieldRef}
          rows={1}
          value={text}
          placeholder={PLACEHOLDER[intent]}
          aria-label={PLACEHOLDER[intent]}
          onChange={(e) => setDraft(sessionId, e.target.value)}
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
      <button
        type="button"
        className={`kprimary is-${glyph} ${!showsStop && !canSend ? 'is-disabled' : ''} ${showsStop && !reachable ? 'is-unreachable' : ''}`}
        aria-label={label}
        data-testid={showsStop ? 'chat-stop' : 'chat-send'}
        onClick={primary}
        disabled={showsStop ? abortPending || !reachable : false}
      >
        {showsStop
          ? abortPending ? <span className="kspinner is-light" aria-hidden /> : <Square className="kprimary-stop" aria-hidden />
          : glyph === 'steer' ? <CornerRightUp aria-hidden /> : <ArrowUp aria-hidden />}
      </button>
    </div>
  );
});
