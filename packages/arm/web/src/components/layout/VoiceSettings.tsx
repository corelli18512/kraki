import { formatNumber } from '../../i18n/format';
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { MicOff, Plus, Trash2 } from 'lucide-react';
import { isImeComposing } from '../../lib/ime';
import { editWords, useVoice, voiceSettings } from '../../lib/voice/voice';
import { SettingsRow, SettingsSection, SettingsSwitch } from './SettingsControls';

function CustomWordRow({
  word,
  onError,
}: {
  word: { term: string; heardAs: string };
  onError: (error: string | null) => void;
}) {
  const { t } = useTranslation('settings');
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
        aria-label={t('voice.wordLabel', { word: word.term })}
        value={term}
        placeholder={t('voice.wordPlaceholder')}
        onChange={(e) => setTerm(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !isImeComposing(e)) e.currentTarget.blur();
        }}
        className="w-[180px] min-w-0 rounded border border-border-primary bg-surface-primary px-2 py-1"
      />
      <input
        aria-label={t('voice.recognizedLabel', { word: word.term })}
        value={heard}
        placeholder={t('voice.heardPlaceholder')}
        onChange={(e) => setHeard(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !isImeComposing(e)) e.currentTarget.blur();
        }}
        className="min-w-0 flex-1 rounded border border-border-primary bg-surface-primary px-2 py-1"
      />
      <button
        type="button"
        aria-label={t('voice.removeWord', { word: word.term })}
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
  const { t } = useTranslation('settings');
  const [term, setTerm] = useState('');
  const [heard, setHeard] = useState('');
  const commit = () => { if (term.trim()) onCommit(term, heard); };
  const enter = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !isImeComposing(e)) commit(); };
  return (
    <li
      className="kp-row"
      style={{ gap: 10 }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commit(); }}
    >
      <input
        autoFocus
        aria-label={t('voice.customWord')}
        value={term}
        placeholder={t('voice.wordPlaceholder')}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={enter}
        className="w-[180px] min-w-0 rounded border border-border-primary bg-surface-primary px-2 py-1"
      />
      <input
        aria-label={t('voice.heardAs')}
        value={heard}
        placeholder={t('voice.heardPlaceholder')}
        onChange={(e) => setHeard(e.target.value)}
        onKeyDown={enter}
        className="min-w-0 flex-1 rounded border border-border-primary bg-surface-primary px-2 py-1"
      />
      <button
        type="button"
        aria-label={t('voice.removeNew')}
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
  const { t } = useTranslation('settings');
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
              {t('voice.unavailable')}
            </p>
          </div>
        </SettingsSection>
      )}
      <SettingsSection footer={t('voice.correctionFooter')}>
        <SettingsRow label={t('voice.correct')}>
          <SettingsSwitch
            label={t('voice.correct')}
            testId="voice-correction"
            on={correction}
            onChange={(v) => {
              voiceSettings.correction = v;
            }}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection footer={t('voice.contextFooter')}>
        <SettingsRow label={t('voice.context')}>
          <SettingsSwitch
            label={t('voice.context')}
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
        title={t('voice.words')}
        footer={t('voice.wordsFooter')}
      >
        <fieldset disabled={!correction} className="disabled:opacity-50">
          <ul data-testid="voice-words">
            {rows === 0 && (
              <li className="kp-row">
                <p className="kp-foot">{t('voice.emptyWords')}</p>
              </li>
            )}
            {rows > 0 && (
              <li className="kp-row text-[11px] text-text-secondary" style={{ justifyContent: 'flex-start', gap: 10 }}>
                <span className="w-[180px]">{t('voice.word')}</span>
                <span>{t('voice.recognizedOptional')}</span>
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
              {t('voice.add')}
            </button>
            <span className="kp-foot">{t('voice.wordCount', { number: formatNumber(words.length), limit: formatNumber(100) })}</span>
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="text-xs text-red-500">
            {error}
          </p>
        )}
        {pending && <p className="kp-foot">{t('voice.syncing')}</p>}
      </SettingsSection>
    </div>
  );
}
