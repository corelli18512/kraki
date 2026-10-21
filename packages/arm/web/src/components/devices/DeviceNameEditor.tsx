import { useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { MAX_DEVICE_NAME_LENGTH, normalizeDeviceName, type DeviceSummary } from '@kraki/protocol';
import { useTranslation } from 'react-i18next';
import { wsClient } from '../../lib/ws-client';

/**
 * A device's name that turns into a text field when clicked. Enter or leaving
 * the field saves; Escape cancels. Saving an empty name (or the device's own
 * name) clears the custom name. The new name shows once the relay confirms it
 * with `device_renamed`, on every device of the account.
 */
export function DeviceNameEditor({ device, className }: { device: DeviceSummary; className?: string }) {
  const { t } = useTranslation('devices');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // Draft before an IME composition started: restored if the composed text
  // would exceed the limit (the composition itself is never cut mid-way).
  const beforeComposition = useRef<string | null>(null);
  const tooLong = (value: string) => [...value].length > MAX_DEVICE_NAME_LENGTH;
  const ownName = device.defaultName ?? device.name;

  const save = () => {
    setEditing(false);
    const name = normalizeDeviceName(draft);
    if (name === null) return;
    const custom = name === ownName ? '' : name;
    if ((custom || ownName) === device.name) return;
    wsClient.renameDevice(device.id, custom);
  };

  if (editing) {
    return (
      <input
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        aria-label={t('rename.field')}
        value={draft}
        placeholder={ownName}
        // Limit by code points like the relay (HTML maxLength counts UTF-16
        // units, so an emoji would count twice). An edit that would go over
        // is refused as a whole, so existing text is never silently cut.
        onChange={(e) => {
          const value = e.target.value;
          if (beforeComposition.current !== null || !tooLong(value)) setDraft(value);
        }}
        onCompositionStart={() => { beforeComposition.current = draft; }}
        onCompositionEnd={(e) => {
          const before = beforeComposition.current;
          beforeComposition.current = null;
          if (before !== null && tooLong(e.currentTarget.value)) setDraft(before);
        }}
        onBlur={save}
        onKeyDown={(e) => {
          // Enter/Escape while an IME composition is open pick/cancel the
          // candidate (Chinese, Japanese…); they must not save or close.
          // keyCode 229 covers Safari, which ends the composition first.
          if (beforeComposition.current !== null || e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') {
            e.stopPropagation();
            setEditing(false);
          }
        }}
        className="ksi-title-input min-w-0 flex-1 text-sm"
      />
    );
  }
  return (
    <button
      type="button"
      className={`group flex min-w-0 items-center gap-1 text-left ${className ?? ''}`}
      title={device.defaultName ? t('rename.titleWithOwn', { name: device.defaultName }) : t('rename.title')}
      aria-label={t('rename.label', { name: device.name })}
      onClick={() => {
        setDraft(device.name);
        setEditing(true);
      }}
    >
      <span className="truncate">{device.name}</span>
      <Pencil size={11} className="shrink-0 text-text-secondary opacity-60 group-hover:opacity-100" aria-hidden="true" />
    </button>
  );
}
