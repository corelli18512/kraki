import { useState, useRef, useEffect } from 'react';
import { wsClient } from '../../lib/ws-client';
import type { PendingQuestion } from '../../types/store';
import { shouldAutoFocusTextInput } from '../../lib/mobile-input';

export function QuestionInput({ question, sessionId }: { question: PendingQuestion; sessionId: string }) {
  const { id, question: text, choices } = question;
  const [freeform, setFreeform] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const shouldAutoFocus = shouldAutoFocusTextInput();

  useEffect(() => {
    if (!shouldAutoFocus) return;
    inputRef.current?.focus();
  }, [id, shouldAutoFocus]);

  const handleAnswer = (answer: string) => {
    wsClient.answer(id, sessionId, answer);
    // On mobile, blur to dismiss the keyboard after answering
    if (!shouldAutoFocus) {
      inputRef.current?.blur();
    }
  };

  return (
    <div className="max-h-[40vh] shrink-0 overflow-y-auto border-t border-violet-500/30 bg-violet-500/5 px-3 pb-3 pt-2.5 sm:px-4 sm:pb-4">
      <div className="mx-auto max-w-3xl">
        {choices && choices.length > 0 && (
          <div className="mb-2 space-y-1.5">
            {choices.map((choice, i) => (
              <button
                key={i}
                onClick={() => handleAnswer(choice)}
                className="w-full rounded-lg border border-border-primary px-3 py-2 text-left text-sm text-text-primary transition-all hover:border-violet-500 hover:bg-violet-500/10 active:scale-[0.98]"
              >
                {choice}
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
              if (e.key === 'Enter' && freeform.trim()) {
                e.preventDefault();
                handleAnswer(freeform.trim());
              }
            }}
            placeholder="Type your answer…"
            className="flex-1 rounded-xl border border-border-primary bg-surface-secondary px-4 py-2.5 text-base text-text-primary placeholder-text-muted focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 sm:text-sm"
          />
          <button
            onClick={() => { if (freeform.trim()) handleAnswer(freeform.trim()); }}
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
