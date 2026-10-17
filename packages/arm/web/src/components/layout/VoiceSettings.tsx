import { useEffect, useState } from 'react';
import { MicOff, Plus, Trash2 } from 'lucide-react';
import { editWords, useVoice, voiceSettings } from '../../lib/voice/voice';
import { SettingsRow, SettingsSection, SettingsSwitch } from './SettingsControls';

function CustomWordRow({
  word,
  onError,
}: {
  word: { term: string; heardAs: string };
  onError: (error: string | null) => void;
}) {
  const [term, setTerm] = useState(word.term);
  const [heard, setHeard] = useState(word.heardAs);
  useEffect(() => {
    setTerm(word.term);
    setHeard(word.heardAs);
  }, [word.term, word.heardAs]);
  const save = () => {
    if (term === word.term && heard === word.heardAs) return;
    onError(editWords([{ op: 'edit', from: word.term, term, heardAs: heard }]));
  };
  return (
    <li className="kp-row" style={{ gap: 10 }}>
      <input
        aria-label={`Word or name: ${word.term}`}
        value={term}
        placeholder="e.g. PostgreSQL"
        onChange={(e) => setTerm(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        className="w-[180px] min-w-0 rounded border border-border-primary bg-surface-primary px-2 py-1"
      />
      <input
        aria-label={`Often recognized as: ${word.term}`}
        value={heard}
        placeholder="Optional, e.g. post gress, postgres Q L"
        onChange={(e) => setHeard(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        className="min-w-0 flex-1 rounded border border-border-primary bg-surface-primary px-2 py-1"
      />
      <button
        type="button"
        aria-label={`Remove ${word.term}`}
        className="text-text-muted hover:text-red-500"
        onClick={() => onError(editWords([{ op: 'remove', term: word.term }]))}
      >
        <Trash2 size={14} />
      </button>
    </li>
  );
}

/** A word being added: an ordinary editable row appended to the list (as on
 *  Mac). It is saved once focus leaves the row with a word in it; an empty
 *  row is never sent and can be discarded with the remove button. */
function NewWordRow({ onCommit, onDiscard }: { onCommit: (term: string, heard: string) => boolean; onDiscard: () => void }) {
  const [term, setTerm] = useState('');
  const [heard, setHeard] = useState('');
  const commit = () => { if (term.trim()) onCommit(term, heard); };
  const enter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') commit(); };
  return (
    <li
      className="kp-row"
      style={{ gap: 10 }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commit(); }}
    >
      <input
        autoFocus
        aria-label="Custom word"
        value={term}
        placeholder="e.g. PostgreSQL"
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={enter}
        className="w-[180px] min-w-0 rounded border border-border-primary bg-surface-primary px-2 py-1"
      />
      <input
        aria-label="Often heard as"
        value={heard}
        placeholder="Optional, e.g. post gress, postgres Q L"
        onChange={(e) => setHeard(e.target.value)}
        onKeyDown={enter}
        className="min-w-0 flex-1 rounded border border-border-primary bg-surface-primary px-2 py-1"
      />
      <button
        type="button"
        aria-label="Remove new word"
        className="text-text-muted hover:text-red-500"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onDiscard}
      >
        <Trash2 size={14} />
      </button>
    </li>
  );
}

let nextDraftId = 0;

export function VoiceSettings() {
  const available = useVoice((s) => !!s.capability);
  const words = useVoice((s) => s.words);
  const pending = useVoice((s) => s.outbox.length > 0);
  useVoice((s) => s.settingsRev);
  const [drafts, setDrafts] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const correction = voiceSettings.correction;
  const commitDraft = (id: number, term: string, heard: string) => {
    if (!correction) return false;
    const err = editWords([{ op: 'add', term, heardAs: heard }]);
    setError(err);
    if (!err) setDrafts((d) => d.filter((x) => x !== id));
    return !err;
  };
  const rows = words.length + drafts.length;
  return (
    <div data-testid="settings-voice" className="kp-voice">
      {!available && (
        <SettingsSection>
          <div className="kp-row" style={{ justifyContent: 'flex-start' }}>
            <MicOff size={18} className="shrink-0 text-text-muted" />
            <p className="kp-unavailable">
              Voice input isn't available with this relay. Your Custom Words still sync to your other devices.
            </p>
          </div>
        </SettingsSection>
      )}
      <SettingsSection footer="After you finish speaking, a third-party AI service fixes recognition mistakes such as names, terms and punctuation; the transcript and your Custom Words are sent to it. Turn off to use exactly what was recognized; your recording is still transcribed by a third-party speech recognition provider.">
        <SettingsRow label="Correct Transcripts">
          <SettingsSwitch
            label="Correct Transcripts"
            testId="voice-correction"
            on={correction}
            onChange={(v) => {
              voiceSettings.correction = v;
            }}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection footer="Sends the conversation title, agent and model, and names or terms that appear in recent messages, to the third-party correction service so names you are discussing are spelled right. Whole messages and anything that looks like a key, token, password or file path are never sent.">
        <SettingsRow label="Use Conversation Context">
          <SettingsSwitch
            label="Use Conversation Context"
            testId="voice-context"
            on={voiceSettings.shareContext}
            disabled={!correction}
            onChange={(v) => {
              voiceSettings.shareContext = v;
            }}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        title="Custom Words"
        footer="Help voice input get your names and terms right, like product names, people or tech jargon. Synced across your devices with your Kraki account and sent to the correction service when you dictate."
      >
        <fieldset disabled={!correction} className="disabled:opacity-50">
          <ul data-testid="voice-words">
            {rows === 0 && (
              <li className="kp-row">
                <p className="kp-foot">No custom words yet. Add names and terms voice input gets wrong.</p>
              </li>
            )}
            {rows > 0 && (
              <li className="kp-row text-[11px] text-text-secondary" style={{ justifyContent: 'flex-start', gap: 10 }}>
                <span className="w-[180px]">Word or name</span>
                <span>Often recognized as (optional)</span>
              </li>
            )}
            {words.map((w) => (
              <CustomWordRow key={w.term} word={w} onError={setError} />
            ))}
            {drafts.map((id) => (
              <NewWordRow
                key={`new-${id}`}
                onCommit={(term, heard) => commitDraft(id, term, heard)}
                onDiscard={() => setDrafts((d) => d.filter((x) => x !== id))}
              />
            ))}
          </ul>
          <div className="kp-row">
            <button
              type="button"
              className="kp-button flex items-center gap-2"
              disabled={rows >= 100}
              onClick={() => setDrafts((d) => [...d, nextDraftId++])}
            >
              <Plus size={14} />
              Add Word
            </button>
            <span className="kp-foot">{words.length} / 100</span>
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="text-xs text-red-500">
            {error}
          </p>
        )}
        {pending && <p className="kp-foot">Syncing…</p>}
      </SettingsSection>
    </div>
  );
}
