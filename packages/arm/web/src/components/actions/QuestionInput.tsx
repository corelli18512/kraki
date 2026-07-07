import { useState, useRef, useEffect } from 'react';
import Markdown from 'react-markdown';
import { HelpCircle } from 'lucide-react';
import { wsClient } from '../../lib/ws-client';
import type { CardActionState } from '@kraki/protocol';
import { shouldAutoFocusTextInput } from '../../lib/mobile-input';

export function QuestionInput({ action, sessionId }: { action: Extract<CardActionState, { kind: 'question' }>; sessionId: string }) {
  const { id, question: text, choices, answer } = action;
  const [freeform, setFreeform] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const shouldAutoFocus = shouldAutoFocusTextInput();

  useEffect(() => {
    if (!shouldAutoFocus || answer !== undefined) return;
    inputRef.current?.focus();
  }, [id, shouldAutoFocus, answer]);

  const handleAnswer = (value: string, wasFreeform: boolean) => {
    wsClient.answer(id, sessionId, value, wasFreeform);
    // On mobile, blur to dismiss the keyboard after answering
    if (!shouldAutoFocus) {
      inputRef.current?.blur();
    }
  };

  // Resolved: read-only view showing the chosen answer, no input controls.
  if (answer !== undefined) {
    return (
      <div className="max-h-[40vh] shrink-0 overflow-y-auto border-t border-violet-500/30 bg-violet-500/5 px-3 pb-3 pt-2.5 sm:px-4 sm:pb-4">
        <div className="mx-auto max-w-3xl">
          {text && (
            <div className="mb-2 flex items-start gap-2">
              <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-violet-500" />
              <div className="min-w-0 text-sm text-text-primary [&_p]:my-0 [&_p+p]:mt-1.5">
                <Markdown>{text}</Markdown>
              </div>
            </div>
          )}
          <div className="rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-sm text-text-primary">
            <span className="mr-1.5 text-xs font-semibold text-violet-600 dark:text-violet-400">✓ Answered</span>
            <Markdown components={{ p: ({ children }) => <>{children}</> }}>{answer}</Markdown>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-h-[40vh] shrink-0 overflow-y-auto border-t border-violet-500/30 bg-violet-500/5 px-3 pb-3 pt-2.5 sm:px-4 sm:pb-4">
      <div className="mx-auto max-w-3xl">
        {text && (
          <div className="mb-2.5 flex items-start gap-2">
            <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-violet-500" />
            <div className="min-w-0 text-sm text-text-primary [&_p]:my-0 [&_p+p]:mt-1.5">
              <Markdown>{text}</Markdown>
            </div>
          </div>
        )}
        {choices && choices.length > 0 && (
          <div className="mb-2 space-y-1.5">
            {choices.map((choice, i) => (
              <button
                key={i}
                onClick={() => handleAnswer(choice, false)}
                className="w-full rounded-lg border border-border-primary px-3 py-2 text-left text-sm text-text-primary transition-all hover:border-violet-500 hover:bg-violet-500/10 active:scale-[0.98]"
              >
                <Markdown components={{ p: ({ children }) => <>{children}</> }}>{choice}</Markdown>
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={freeform}
            onChange={(e) => setFreeform(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229 && freeform.trim()) {
                e.preventDefault();
                handleAnswer(freeform.trim(), true);
              }
            }}
            placeholder="Type your answer…"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="flex-1 rounded-xl border border-border-primary bg-surface-secondary px-4 py-2.5 text-base text-text-primary placeholder-text-muted focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 sm:text-sm"
          />
          <button
            onClick={() => { if (freeform.trim()) handleAnswer(freeform.trim(), true); }}
            disabled={!freeform.trim()}
            aria-label="Send answer"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-500 text-white transition-all hover:bg-violet-600 active:scale-95 disabled:opacity-40 disabled:hover:bg-violet-500"
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
