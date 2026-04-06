import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { wsClient } from '../../lib/ws-client';
import { useStore } from '../../hooks/useStore';
import { shouldAutoFocusTextInput } from '../../lib/mobile-input';
import { X, ImagePlus, Square } from 'lucide-react';
import type { Attachment } from '@kraki/protocol';

const MAX_INPUT_HEIGHT = 160;
const MAX_IMAGE_SIZE = 3 * 1024 * 1024; // 3MB (SDK limit)
const MAX_IMAGE_DIMENSION = 1024;

const MODES = ['safe', 'discuss', 'execute', 'delegate'] as const;

const MODE_COLORS: Record<typeof MODES[number], { pill: string; text: string }> = {
  safe:     { pill: 'bg-emerald-400/80 dark:bg-emerald-500/60', text: 'text-emerald-900 dark:text-emerald-100' },
  discuss:  { pill: 'bg-ocean-400/80 dark:bg-ocean-500/60',     text: 'text-ocean-900 dark:text-ocean-100' },
  execute:  { pill: 'bg-amber-400/80 dark:bg-amber-500/60',     text: 'text-amber-900 dark:text-amber-100' },
  delegate: { pill: 'bg-kraki-400/80 dark:bg-kraki-500/60',     text: 'text-kraki-900 dark:text-kraki-100' },
};

export function MessageInput({ sessionId }: { sessionId: string }) {
  const text = useStore((s) => s.drafts.get(sessionId) ?? '');
  const setDraft = useStore((s) => s.setDraft);
  const sessionMode = useStore((s) => s.sessionModes.get(sessionId) ?? 'discuss') as typeof MODES[number];
  const session = useStore((s) => s.sessions.get(sessionId));
  const sessionActive = session?.state === 'active';
  const [awaitingActive, setAwaitingActive] = useState(false);
  const isIdle = !sessionActive && !awaitingActive;

  // Clear awaitingActive once session goes active
  useEffect(() => {
    if (sessionActive) setAwaitingActive(false);
  }, [sessionActive]);
  const modeContainerRef = useRef<HTMLDivElement>(null);
  const mobileContainerRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState({ left: 0, width: 0 });
  const [mobilePill, setMobilePill] = useState<{ left: number; width: number } | null>(null);
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const [mobileClosing, setMobileClosing] = useState(false);
  const activeIdx = MODES.indexOf(sessionMode);
  const colors = MODE_COLORS[sessionMode];

  // Desktop pill position
  useLayoutEffect(() => {
    const container = modeContainerRef.current;
    if (!container) return;
    const btn = container.querySelectorAll('button')[activeIdx] as HTMLElement;
    if (btn) {
      setPill({ left: btn.offsetLeft, width: btn.offsetWidth });
    }
  }, [activeIdx]);

  // Mobile expanded pill position
  useLayoutEffect(() => {
    if (!mobileExpanded) { setMobilePill(null); return; }
    const container = mobileContainerRef.current;
    if (!container) return;
    const btn = container.querySelectorAll('button')[activeIdx] as HTMLElement;
    if (btn) {
      setMobilePill({ left: btn.offsetLeft, width: btn.offsetWidth });
    }
  }, [activeIdx, mobileExpanded]);

  const closeMobile = () => {
    setMobileClosing(true);
    setTimeout(() => { setMobileExpanded(false); setMobileClosing(false); }, 200);
  };

  // Auto-collapse mobile mode switcher after 3s
  useEffect(() => {
    if (!mobileExpanded || mobileClosing) return;
    const timer = setTimeout(closeMobile, 3000);
    return () => clearTimeout(timer);
  }, [mobileExpanded, mobileClosing]);

  const handleMobileSelect = (mode: typeof MODES[number]) => {
    wsClient.setSessionMode(sessionId, mode);
    closeMobile();
  };

  // Shift+Tab rotates permission mode
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        const nextIdx = (activeIdx + 1) % MODES.length;
        wsClient.setSessionMode(sessionId, MODES[nextIdx]);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [sessionId, activeIdx]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const shouldAutoFocus = shouldAutoFocusTextInput();
  const [imageAttachment, setImageAttachment] = useState<Attachment | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [pendingReplaceFile, setPendingReplaceFile] = useState<File | null>(null);

  const compressAndAttach = useCallback(async (file: File) => {
    const img = new window.Image();
    const url = URL.createObjectURL(file);
    img.src = url;
    await new Promise((resolve) => { img.onload = resolve; });
    URL.revokeObjectURL(url);

    let { width, height } = img;
    if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
      const scale = MAX_IMAGE_DIMENSION / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, width, height);

    let dataUrl = canvas.toDataURL(file.type || 'image/jpeg', 0.8);
    const base64 = dataUrl.split(',')[1];
    const byteSize = Math.ceil(base64.length * 3 / 4);

    if (byteSize > MAX_IMAGE_SIZE) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.6);
      const retryBase64 = dataUrl.split(',')[1];
      const retrySize = Math.ceil(retryBase64.length * 3 / 4);
      if (retrySize > MAX_IMAGE_SIZE) {
        alert('Image is too large (max 3MB after compression)');
        return;
      }
      setImageAttachment({ type: 'image', mimeType: 'image/jpeg', data: retryBase64 });
      setImagePreview(dataUrl);
      return;
    }

    const mimeType = dataUrl.substring(5, dataUrl.indexOf(';'));
    setImageAttachment({ type: 'image', mimeType, data: base64 });
    setImagePreview(dataUrl);
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (imageAttachment) { setPendingReplaceFile(file); } else { compressAndAttach(file); }
    e.target.value = '';
  }, [imageAttachment, compressAndAttach]);

  const clearImage = useCallback(() => {
    setImageAttachment(null);
    setImagePreview(null);
  }, []);

  const confirmReplace = useCallback(() => {
    if (pendingReplaceFile) {
      compressAndAttach(pendingReplaceFile);
      setPendingReplaceFile(null);
    }
  }, [pendingReplaceFile, compressAndAttach]);

  const cancelReplace = useCallback(() => {
    setPendingReplaceFile(null);
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) return;
        if (imageAttachment) { setPendingReplaceFile(file); } else { compressAndAttach(file); }
        return;
      }
    }
  }, [imageAttachment, compressAndAttach]);

  // Auto-focus on mount
  useEffect(() => {
    if (!shouldAutoFocus) return;
    textareaRef.current?.focus();
  }, [sessionId, shouldAutoFocus]);

  // Auto-focus on keypress
  useEffect(() => {
    if (!shouldAutoFocus) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.activeElement === textareaRef.current) return;
      if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
      if (e.key.length === 1) textareaRef.current?.focus();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shouldAutoFocus]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, MAX_INPUT_HEIGHT) + 'px';
    }
  }, [text]);

  const handleSend = () => {
    if (!isIdle) return;
    const trimmed = text.trim();
    if (!trimmed && !imageAttachment) return;
    const attachments = imageAttachment ? [imageAttachment] : undefined;
    wsClient.sendInput(sessionId, trimmed || '[image]', attachments);
    setDraft(sessionId, '');
    clearImage();
    setAwaitingActive(true);
    if (!shouldAutoFocus) textareaRef.current?.blur();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="relative shrink-0 bg-surface-primary px-3 pb-3 pt-1.5 sm:px-4 sm:pb-4 sm:pt-2">
      <div className="pointer-events-none absolute inset-x-0 -top-4 h-4 bg-gradient-to-t from-surface-primary to-transparent" />
      <div className="mx-auto max-w-3xl">
        {/* Image upload + Mode switcher row */}
        <input
          id={`img-upload-${sessionId}`}
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
        <div className="relative mb-1.5 flex items-center gap-1.5">
          <label
            htmlFor={`img-upload-${sessionId}`}
            aria-label={imagePreview ? 'Replace image' : 'Attach image'}
            className={`shrink-0 cursor-pointer rounded-lg transition-colors active:scale-95 ${!isIdle ? 'pointer-events-none opacity-40' : ''} ${imagePreview ? '' : 'flex h-8 w-8 items-center justify-center text-text-muted hover:bg-surface-tertiary hover:text-text-primary'}`}
          >
            {imagePreview ? (
              <div className="relative">
                <img src={imagePreview} alt="Preview" className="h-8 max-w-16 rounded-lg border border-border-primary object-contain transition-opacity hover:opacity-80" />
                <button
                  onClick={(e) => { e.preventDefault(); clearImage(); }}
                  aria-label="Remove image"
                  className="absolute -right-1 -top-1 rounded-full bg-surface-primary p-0.5 shadow-sm border border-border-primary"
                >
                  <X className="h-2.5 w-2.5 text-text-muted" />
                </button>
              </div>
            ) : (
              <ImagePlus className="h-4.5 w-4.5" />
            )}
          </label>
          <div className="flex-1" />
          {/* Desktop: always show all modes */}
          <div ref={modeContainerRef} className="relative hidden items-center rounded-full bg-surface-secondary p-0.5 sm:flex">
            <div
              className={`absolute top-0.5 h-[calc(100%-4px)] rounded-full shadow-sm transition-all duration-500 ease-in-out ${colors.pill}`}
              style={{ left: pill.left, width: pill.width }}
            />
            {MODES.map((mode) => (
              <button
                key={mode}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => wsClient.setSessionMode(sessionId, mode)}
                className={`relative z-10 px-3 py-1 rounded-full text-xs font-medium transition-colors duration-200 ${
                  sessionMode === mode ? colors.text : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
          {/* Mobile collapsed: show current mode only */}
          {!mobileExpanded && (
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setMobileExpanded(true)}
              className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium sm:hidden ${colors.pill} ${colors.text}`}
            >
              {sessionMode.charAt(0).toUpperCase() + sessionMode.slice(1)}
            </button>
          )}
          {/* Mobile expanded: all modes — positioned within this row */}
          {mobileExpanded && (
            <div className={`absolute inset-0 z-10 flex items-center justify-end bg-gradient-to-l from-surface-primary via-surface-primary to-transparent pl-4 pr-0 sm:hidden ${mobileClosing ? 'animate-slide-out-right' : 'animate-slide-in-right'}`}>
              <div ref={mobileContainerRef} className="relative flex items-center rounded-full bg-surface-secondary p-0.5">
                {mobilePill && (
                  <div
                    className={`absolute top-0.5 h-[calc(100%-4px)] rounded-full shadow-sm transition-all duration-500 ease-in-out ${colors.pill}`}
                    style={{ left: mobilePill.left, width: mobilePill.width }}
                  />
                )}
                {MODES.map((mode) => (
                  <button
                    key={mode}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleMobileSelect(mode)}
                    className={`relative z-10 px-3 py-1 rounded-full text-xs font-medium transition-colors duration-200 ${
                      sessionMode === mode ? colors.text : 'text-text-muted hover:text-text-secondary'
                    }`}
                  >
                    {mode.charAt(0).toUpperCase() + mode.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Input row */}
        <div className="relative flex gap-2">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setDraft(sessionId, e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={1}
            disabled={!isIdle}
            placeholder={isIdle ? 'Send a message…' : 'Agent is working…'}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="send"
            className="min-w-0 flex-1 cursor-text resize-none overflow-hidden rounded-xl border border-border-primary bg-surface-secondary px-4 pt-[7px] pb-[9px] pr-9 text-base text-text-primary placeholder-text-muted focus:border-kraki-500 focus:outline-none focus:ring-1 focus:ring-kraki-500 disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm"
          />
          {isIdle && text && (
            <button
              onClick={() => { setDraft(sessionId, ''); textareaRef.current?.focus(); }}
              aria-label="Clear input"
              className="absolute right-[3.75rem] top-1/2 -translate-y-1/2 rounded-full p-0.5 text-text-muted transition-colors hover:bg-surface-tertiary hover:text-text-primary"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={isIdle ? handleSend : () => wsClient.abortSession(sessionId)}
            disabled={isIdle && !text.trim() && !imageAttachment}
            aria-label={isIdle ? 'Send message' : 'Stop'}
            className={`relative flex h-9 w-9 shrink-0 items-center justify-center self-center rounded-xl text-white transition-all duration-500 active:scale-95 ${
              isIdle
                ? 'bg-kraki-500 hover:bg-kraki-600 active:bg-kraki-700 disabled:opacity-40 disabled:hover:bg-kraki-500 disabled:active:scale-100'
                : 'animate-pulse-subtle bg-kraki-500 hover:bg-kraki-600'
            }`}
          >
            <svg
              className={`absolute h-4 w-4 transition-all duration-500 ${isIdle ? 'scale-100 opacity-100' : 'scale-0 opacity-0'}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
            </svg>
            <Square className={`absolute h-3.5 w-3.5 fill-current transition-all duration-500 ${isIdle ? 'scale-0 opacity-0' : 'scale-100 opacity-100'}`} />
          </button>
        </div>
      </div>

      {/* Image replace confirmation */}
      {pendingReplaceFile && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={cancelReplace}>
          <div className="mx-4 rounded-xl bg-surface-primary p-4 shadow-xl border border-border-primary" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-medium text-text-primary">Replace image?</p>
            <p className="mt-1 text-xs text-text-muted">The current image will be replaced with the new one.</p>
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={cancelReplace} className="rounded-lg px-3 py-1.5 text-xs font-medium text-text-muted hover:bg-surface-tertiary">Cancel</button>
              <button onClick={confirmReplace} className="rounded-lg bg-kraki-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-kraki-600">Replace</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
