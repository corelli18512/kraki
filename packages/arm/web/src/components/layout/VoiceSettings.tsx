import { useState } from 'react';
import { MicOff, Trash2 } from 'lucide-react';
import { editWords, useVoice, voiceSettings } from '../../lib/voice/voice';
import { SettingsRow, SettingsSection, SettingsSwitch } from './SettingsControls';

export function VoiceSettings() {
  const available = useVoice((s) => !!s.capability);
  const words = useVoice((s) => s.words);
  const pending = useVoice((s) => s.outbox.length > 0);
  useVoice((s) => s.settingsRev);
  const [adding, setAdding] = useState(false);
  const [term, setTerm] = useState('');
  const [heard, setHeard] = useState('');
  const [error, setError] = useState<string | null>(null);
  const correction = voiceSettings.correction;
  const add = () => {
    if (!correction || !term.trim()) return;
    const err = editWords([{ op: 'add', term, heardAs: heard }]);
    setError(err);
    if (!err) { setTerm(''); setHeard(''); setAdding(false); }
  };
  return <div data-testid="settings-voice">
    {!available && <SettingsSection><div className="kp-row" style={{ justifyContent: 'flex-start' }}><MicOff size={18} className="shrink-0 text-text-muted" /><p className="kp-foot">Voice input isn't available with this relay. Your custom words still sync to your other devices.</p></div></SettingsSection>}
    <SettingsSection><SettingsRow label="Correct Transcripts"><SettingsSwitch label="Correct Transcripts" testId="voice-correction" on={correction} onChange={(v) => { voiceSettings.correction = v; }} /></SettingsRow><p className="kp-foot">A third-party AI service fixes names and mistakes; the transcript and your custom words are sent to it. Off: exactly what speech recognition heard.</p></SettingsSection>
    <SettingsSection><SettingsRow label="Use Conversation Context"><SettingsSwitch label="Use Conversation Context" testId="voice-context" on={voiceSettings.shareContext} disabled={!correction} onChange={(v) => { voiceSettings.shareContext = v; }} /></SettingsRow><p className="kp-foot">The title, agent, model and names from recent messages are sent to the correction service. Never whole messages or anything like a key.</p></SettingsSection>
    <SettingsSection title="Custom Words"><fieldset disabled={!correction} className="disabled:opacity-50"><ul data-testid="voice-words">{words.length === 0 && <li className="kp-row"><p className="kp-foot">No custom words yet. Add names and terms voice input gets wrong.</p></li>}{words.map((w) => <li key={w.term} className="kp-row"><span className="font-medium">{w.term}</span>{w.heardAs && <span className="flex-1 text-[11.5px] text-text-muted">“{w.heardAs}”</span>}<button type="button" aria-label={`Remove ${w.term}`} className="text-text-muted hover:text-red-500" onClick={() => editWords([{ op: 'remove', term: w.term }])}><Trash2 size={14} /></button></li>)}</ul>
    {adding ? <div className="py-2"><div className="flex gap-2"><input autoFocus value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} placeholder="Word" aria-label="Custom word" className="w-28 rounded border border-border-primary bg-surface-primary px-2 py-1" /><input value={heard} onChange={(e) => setHeard(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} placeholder="Often heard as (optional)" aria-label="Often heard as" className="min-w-0 flex-1 rounded border border-border-primary bg-surface-primary px-2 py-1" /></div><div className="mt-2 flex justify-end gap-2"><button type="button" className="kp-button" onClick={() => setAdding(false)}>Cancel</button><button type="button" disabled={!term.trim()} className="kp-button" onClick={add}>Add Word</button></div></div> : <div className="kp-row"><button type="button" className="kp-button" disabled={words.length >= 100} onClick={() => setAdding(true)}>Add Word</button><span className="kp-foot">{words.length} / 100</span></div>}
    </fieldset><p className="kp-foot">Names and terms you use, and how they're often misheard. Synced to your account and sent to the correction service when you dictate.</p>{error && <p role="alert" className="text-xs text-red-500">{error}</p>}{pending && <p className="kp-foot">Syncing…</p>}</SettingsSection>
  </div>;
}
