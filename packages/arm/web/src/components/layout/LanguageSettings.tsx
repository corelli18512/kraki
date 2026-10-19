import { useTranslation } from 'react-i18next';
import { LANGUAGES, resolveLanguage, type LanguagePreference } from '../../i18n';
import { useLanguagePreference } from '../../i18n/useLanguage';
import { SettingsRow, SettingsSection } from './SettingsControls';

/** Settings › General › Language. 'System' follows the OS/browser language. */
export function LanguageSettingsRow() {
  const { t } = useTranslation('settings');
  const { preference, setPreference } = useLanguagePreference();
  const systemName = LANGUAGES.find((l) => l.code === resolveLanguage('system'))?.nativeName ?? '';
  return (
    <SettingsSection footer={t('language.footer')}>
      <SettingsRow label={t('language.label')}>
        <select
          className="kp-select"
          aria-label={t('language.label')}
          data-testid="settings-language"
          value={preference}
          onChange={(e) => setPreference(e.target.value as LanguagePreference)}
        >
          <option value="system">{t('language.system', { language: systemName })}</option>
          {LANGUAGES.map((l) => (
            // Each language is shown in its own name so it is findable from any UI language.
            <option key={l.code} value={l.code} lang={l.code}>
              {l.nativeName}
            </option>
          ))}
        </select>
      </SettingsRow>
    </SettingsSection>
  );
}
