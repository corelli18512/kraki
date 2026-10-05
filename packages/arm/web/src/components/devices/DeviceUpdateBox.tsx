import { useEffect, useState } from 'react';
import type { DeviceSummary } from '@kraki/protocol';
import { useStore } from '../../hooks/useStore';
import { wsClient } from '../../lib/ws-client';
import { availableUpdate, isActivePhase, updateHowTo, updateTitle, type UpdateProgress } from '../../lib/device-update';

/** "Kraki x is available", the Update button (remote update), progress and outcome. */
export function DeviceUpdateBox({ device }: { device: DeviceSummary }) {
  const deviceUpdates = useStore((s) => s.deviceUpdates);
  const deviceVersions = useStore((s) => s.deviceVersions);
  const progress = useStore((s) => s.updateProgress.get(device.id));
  const setUpdateProgress = useStore((s) => s.setUpdateProgress);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const update = availableUpdate(device, deviceUpdates, deviceVersions);
  const visible = progress && (isActivePhase(progress.phase) || progress.phase === 'busy' || now - progress.at < 600_000);
  if (!visible && !update) return null;

  const box = (tone: 'info' | 'ok' | 'warn' | 'bad', title: string, body?: React.ReactNode) => (
    <div
      data-testid="device-update"
      className={`rounded-lg border px-3 py-2 ${{
        info: 'border-kraki-500/30 bg-kraki-500/10',
        ok: 'border-emerald-500/30 bg-emerald-500/10',
        warn: 'border-amber-500/30 bg-amber-500/10',
        bad: 'border-red-500/30 bg-red-500/10',
      }[tone]}`}
    >
      <div className="text-xs font-medium text-text-primary">{title}</div>
      {body && <div className="mt-1 text-[11px] text-text-secondary">{body}</div>}
    </div>
  );

  if (visible && progress) return progressBox(progress);

  if (!update) return null;
  if (update.remote) {
    return box('info', updateTitle(update), (
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!device.online}
          onClick={() => wsClient.updateDevice(device.id)}
          className="rounded-md bg-kraki-500 px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-40"
        >
          Update
        </button>
        <span>{device.online ? `Kraki restarts on ${device.name}; about a minute.` : `Available when ${device.name} is online.`}</span>
      </div>
    ));
  }
  const block = deviceUpdates.get(device.id)?.remoteBlock;
  const text = block === 'disabled'
    ? `Updating from other devices is turned off on that computer. ${updateHowTo(update)}`
    : block === 'not_writable'
      ? 'Kraki is installed where only an administrator can change it. Run `kraki update` on that computer.'
      : updateHowTo(update);
  return box('info', updateTitle(update), text);

  function progressBox(p: UpdateProgress) {
    const to = p.to ? ` ${p.to}` : '';
    switch (p.phase) {
      case 'requested': return box('info', `Asking ${device.name} to update…`);
      case 'busy': {
        const n = p.runningSessions ?? 0;
        return box('warn', `${n === 1 ? '1 session is' : `${n} sessions are`} running`, (
          <div className="space-y-1.5">
            <div>Updating restarts Kraki on {device.name} and stops these sessions.</div>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" className="rounded-md bg-kraki-500 px-2 py-1 text-[11px] font-semibold text-white" onClick={() => wsClient.updateDevice(device.id, 'now')}>Update now</button>
              <button type="button" className="rounded-md bg-surface-tertiary px-2 py-1 text-[11px] font-medium" onClick={() => wsClient.updateDevice(device.id, 'idle')}>Update when they finish</button>
              <button type="button" className="px-2 py-1 text-[11px]" onClick={() => setUpdateProgress(device.id, null)}>Cancel</button>
            </div>
          </div>
        ));
      }
      case 'waiting_idle': return box('info', 'Will update when the running sessions finish', `Kraki${to} installs on ${device.name} as soon as nothing is running.`);
      case 'downloading': return box('info', `Downloading Kraki${to}…`, p.progress !== undefined ? (
        <div className="h-1.5 w-48 overflow-hidden rounded-full bg-surface-tertiary"><div className="h-full bg-kraki-500" style={{ width: `${Math.round(p.progress * 100)}%` }} /></div>
      ) : undefined);
      case 'installing':
        return now - p.at > 180_000
          ? box('warn', `${device.name} isn’t back online yet`, 'If it doesn’t return, check Kraki on that computer.')
          : box('info', device.online ? `Installing Kraki${to}…` : `Restarting Kraki on ${device.name}…`, 'It will be back online in a moment.');
      case 'updated': return box('ok', `✓ Updated to Kraki${to}`);
      case 'rolled_back': return box('warn', 'Update didn’t work, so nothing changed', `The new version didn’t start on ${device.name}, so it went back to ${p.from ?? 'the previous version'}.`);
      case 'failed': return box('bad', 'Couldn’t update', (
        <span>{p.error ?? 'Something went wrong. Nothing was changed.'} <button type="button" className="underline" onClick={() => setUpdateProgress(device.id, null)}>Dismiss</button></span>
      ));
      default: return null;
    }
  }
}
