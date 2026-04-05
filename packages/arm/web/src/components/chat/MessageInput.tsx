import { useRef, useEffect, useLayoutEffect, useState } from 'react';
import { wsClient } from '../../lib/ws-client';
import { useStore } from '../../hooks/useStore';
import { shouldAutoFocusTextInput } from '../../lib/mobile-input';
import { X } from 'lucide-react';

const MAX_INPUT_HEIGHT = 160;

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
  const modeContainerRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState({ left: 0, width: 0 });
  const activeIdx = MODES.indexOf(sessionMode);
  const colors = MODE_COLORS[sessionMode];

  useLayoutEffect(() => {
    const container = modeContainerRef.current;
    if (!container) return;
    const btn = container.querySelectorAll('button')[activeIdx] as HTMLElement;
    if (btn) {
      setPill({ left: btn.offsetLeft, width: btn.offsetWidth });
    }
  }, [activeIdx]);

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
  const shouldAutoFocus = shouldAutoFocusTextInput();

  // Auto-focus on mount (when navigating into a session)
  useEffect(() => {
    if (!shouldAutoFocus) return;
    textareaRef.current?.focus();
  }, [sessionId, shouldAutoFocus]);

  // Auto-focus on keypress when no other input is focused
  useEffect(() => {
    if (!shouldAutoFocus) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.activeElement === textareaRef.current) return;
      if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
      if (e.key.length === 1) {
        textareaRef.current?.focus();
      }
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
    const trimmed = text.trim();
    if (!trimmed) return;
    wsClient.sendInput(sessionId, trimmed);
    setDraft(sessionId, '');
    // On mobile, blur to dismiss the keyboard after sending
    if (!shouldAutoFocus) {
      textareaRef.current?.blur();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const quickSend = (msg: string) => {
    wsClient.sendInput(sessionId, msg);
  };

  const quickReplies: Array<{ label: string; style: string }> = [
    { label: 'Yes', style: 'border-emerald-400/20 text-emerald-500/70 hover:bg-emerald-500/5 dark:text-emerald-200 dark:border-emerald-300/40 dark:hover:bg-emerald-500/15' },
    { label: 'No', style: 'border-red-400/20 text-red-400/70 hover:bg-red-500/5 dark:text-red-200 dark:border-red-300/40 dark:hover:bg-red-500/15' },
    { label: 'Continue', style: 'border-blue-400/20 text-blue-500/70 hover:bg-blue-500/5 dark:text-blue-200 dark:border-blue-300/40 dark:hover:bg-blue-500/15' },
  ];

  return (
    <div className="relative shrink-0 bg-surface-primary px-3 pb-3 pt-1.5 sm:px-4 sm:pb-4 sm:pt-2">
      <div className="pointer-events-none absolute inset-x-0 -top-4 h-4 bg-gradient-to-t from-surface-primary to-transparent" />
      <div className="mx-auto max-w-3xl">
        <div className="mb-1.5 flex items-center gap-1.5">
          {quickReplies.map(({ label, style }) => (
            <button
              key={label}
              onClick={() => quickSend(label)}
              className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors active:scale-95 ${style}`}
            >
              {label}
            </button>
          ))}
          <div className="mx-0.5 self-stretch border-l border-border-primary" />
          <button
            onClick={() => wsClient.abortSession(sessionId)}
            className="rounded-lg border border-border-primary px-2.5 py-1 text-[11px] font-medium text-text-muted transition-colors hover:bg-surface-tertiary active:scale-95 dark:text-text-primary dark:hover:bg-surface-secondary"
          >
            Cancel
          </button>
          <div className="flex-1" />
          {/* Mode selector with sliding pill */}
          <div ref={modeContainerRef} className="relative flex items-center rounded-full bg-surface-secondary p-0.5">
            <div
              className={`absolute top-0.5 h-[calc(100%-4px)] rounded-full shadow-sm transition-all duration-300 ease-in-out ${colors.pill}`}
              style={{ left: pill.left, width: pill.width }}
            />
            {MODES.map((mode) => (
              <button
                key={mode}
                onClick={() => wsClient.setSessionMode(sessionId, mode)}
                className={`relative z-10 px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-colors duration-200 ${
                  sessionMode === mode ? colors.text : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="relative flex gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setDraft(sessionId, e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder="Send a message…"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="send"
          className="min-w-0 flex-1 cursor-text resize-none overflow-hidden rounded-xl border border-border-primary bg-surface-secondary px-4 pt-[7px] pb-[9px] pr-9 text-base text-text-primary placeholder-text-muted focus:border-kraki-500 focus:outline-none focus:ring-1 focus:ring-kraki-500 sm:text-sm"
        />
        {text && (
          <button
            onClick={() => { setDraft(sessionId, ''); textareaRef.current?.focus(); }}
            aria-label="Clear input"
            className="absolute right-[3.75rem] top-1/2 -translate-y-1/2 rounded-full p-0.5 text-text-muted transition-colors hover:bg-surface-tertiary hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        <button
          onClick={handleSend}
          disabled={!text.trim()}
          aria-label="Send message"
          className="flex h-10 w-10 shrink-0 items-center justify-center self-center rounded-xl bg-kraki-500 text-white transition-all hover:bg-kraki-600 active:scale-95 active:bg-kraki-700 disabled:opacity-40 disabled:hover:bg-kraki-500 disabled:active:scale-100"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </button>
        </div>
      </div>
    </div>
  );
}
