import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { MAX_DEVICE_NAME_LENGTH, normalizeDeviceName, type DeviceSummary } from '@kraki/protocol';
import { wsClient } from '../../lib/ws-client';

/**
 * A device's name that turns into a text field when clicked. Enter or leaving
 * the field saves; Escape cancels. Saving an empty name (or the device's own
 * name) clears the custom name. The new name shows once the relay confirms it
 * with `device_renamed`, on every device of the account.
 */
export function DeviceNameEditor({ device, className }: { device: DeviceSummary; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
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
        aria-label="Device name"
        value={draft}
        placeholder={ownName}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') {
            e.stopPropagation();
            setEditing(false);
          }
        }}
        maxLength={MAX_DEVICE_NAME_LENGTH}
        className="ksi-title-input min-w-0 flex-1 text-sm"
      />
    );
  }
  return (
    <button
      type="button"
      className={`group flex min-w-0 items-center gap-1 text-left ${className ?? ''}`}
      title={device.defaultName ? `Rename (its own name: ${device.defaultName})` : 'Rename'}
      aria-label={`Rename ${device.name}`}
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
