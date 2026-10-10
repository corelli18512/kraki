/**
 * Settings › Voice Input — Mac/iOS: Correct Transcripts, Use Conversation
 * Context, and Custom Words (the account's list, synced across devices).
 */
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { editWords, useVoice, voiceSettings } from '../../lib/voice/voice';
import { useStore } from '../../hooks/useStore';

function Switch({ on, onChange, label, testId }: { on: boolean; onChange: (v: boolean) => void; label: string; testId: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} data-testid={testId} onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? 'bg-kraki-500' : 'bg-slate-300 dark:bg-slate-600'}`}>
      <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0'}`} />
    </button>
  );
}

export function VoiceSettings() {
  const available = useVoice((s) => !!s.capability);
  const connected = useStore((s) => s.status === 'connected');
  const words = useVoice((s) => s.words);
  const pending = useVoice((s) => s.outbox.length > 0);
  useVoice((s) => s.settingsRev); // re-render after a toggle
  const [term, setTerm] = useState('');
  const [heard, setHeard] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!connected) return null;

  const add = () => {
    if (!term.trim()) return;
    const err = editWords([{ op: 'add', term, heardAs: heard }]);
    setError(err);
    if (!err) { setTerm(''); setHeard(''); }
  };

  return (
    <section data-testid="settings-voice">
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Voice Input</h3>
      {!available && <p className="mb-3 text-[11px] text-text-muted">Voice input isn't available with this relay. Your custom words still sync to your other devices.</p>}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-text-primary">Correct transcripts</p>
            <p className="text-[11px] text-text-muted">A third-party AI service fixes names and mistakes; the transcript and your custom words are sent to it. Off: exactly what speech recognition heard.</p>
          </div>
          <Switch label="Correct transcripts" testId="voice-correction" on={voiceSettings.correction} onChange={(v) => { voiceSettings.correction = v; }} />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-text-primary">Use conversation context</p>
            <p className="text-[11px] text-text-muted">The title, agent, model and names from recent messages are sent to the correction service. Never whole messages or anything like a key.</p>
          </div>
          <Switch label="Use conversation context" testId="voice-context" on={voiceSettings.shareContext} onChange={(v) => { voiceSettings.shareContext = v; }} />
        </div>
        <div>
          <p className="text-sm text-text-primary">Custom words</p>
          <p className="text-[11px] text-text-muted">Names and terms you use, and how they're often misheard. Synced to your account and sent to the correction service when you dictate.</p>
          <ul className="mt-2 divide-y divide-border-primary rounded-lg bg-surface-secondary" data-testid="voice-words">
            {words.map((w) => (
              <li key={w.term} className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
                <span className="font-medium text-text-primary">{w.term}</span>
                {w.heardAs && <span className="min-w-0 flex-1 truncate text-[11.5px] text-text-muted">“{w.heardAs}”</span>}
                {!w.heardAs && <span className="flex-1" />}
                <button type="button" aria-label={`Remove ${w.term}`} className="text-text-muted hover:text-red-500" onClick={() => editWords([{ op: 'remove', term: w.term }])}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
            <li className="flex items-center gap-2 px-2 py-1.5">
              <input value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} placeholder="Word"
                aria-label="Custom word" className="w-28 rounded-md bg-surface-primary px-2 py-1 text-[13px] text-text-primary outline-none ring-1 ring-border-primary" />
              <input value={heard} onChange={(e) => setHeard(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} placeholder="Often heard as (optional)"
                aria-label="Often heard as" className="min-w-0 flex-1 rounded-md bg-surface-primary px-2 py-1 text-[13px] text-text-primary outline-none ring-1 ring-border-primary" />
              <button type="button" aria-label="Add word" disabled={!term.trim()} onClick={add} className="rounded-md p-1 text-kraki-500 disabled:opacity-40"><Plus className="h-4 w-4" /></button>
            </li>
          </ul>
          {error && <p className="mt-1 text-[11px] text-red-500">{error}</p>}
          {pending && <p className="mt-1 text-[11px] text-text-muted">Syncing…</p>}
        </div>
      </div>
    </section>
  );
}
