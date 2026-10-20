import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import type { DeviceSummary } from '@kraki/protocol';
import { useStore } from '../../hooks/useStore';
import { wsClient } from '../../lib/ws-client';
import { availableUpdate, isActivePhase, updateHowTo, updateTitle, type UpdateProgress } from '../../lib/device-update';

/** "Kraki x is available", the Update button (remote update), progress and outcome. */
export function DeviceUpdateBox({ device }: { device: DeviceSummary }) {
  const { t } = useTranslation('devices');
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
          {t('update.button')}
        </button>
        <span>{device.online ? t('update.restartHint', { name: device.name }) : t('update.offlineHint', { name: device.name })}</span>
      </div>
    ));
  }
  const block = deviceUpdates.get(device.id)?.remoteBlock;
  const text = block === 'disabled'
    ? t('update.disabled', { howTo: updateHowTo(update) })
    : block === 'not_writable'
      ? t('update.admin')
      : updateHowTo(update);
  return box('info', updateTitle(update), text);

  function progressBox(p: UpdateProgress) {
    const to = p.to ? ` ${p.to}` : '';
    switch (p.phase) {
      case 'requested': return box('info', t('update.requested', { name: device.name }));
      case 'busy': {
        const n = p.runningSessions ?? 0;
        return box('warn', t('update.busy', { count: n }), (
          <div className="space-y-1.5">
            <div>{t('update.stopsSessions', { name: device.name })}</div>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" className="rounded-md bg-kraki-500 px-2 py-1 text-[11px] font-semibold text-white" onClick={() => wsClient.updateDevice(device.id, 'now')}>{t('update.now')}</button>
              <button type="button" className="rounded-md bg-surface-tertiary px-2 py-1 text-[11px] font-medium" onClick={() => wsClient.updateDevice(device.id, 'idle')}>{t('update.whenIdle')}</button>
              <button type="button" className="px-2 py-1 text-[11px]" onClick={() => setUpdateProgress(device.id, null)}>{t('update.cancel')}</button>
            </div>
          </div>
        ));
      }
      case 'waiting_idle': return box('info', t('update.waiting'), t('update.idleDetail', { version: to, name: device.name }));
      case 'downloading': return box('info', t('update.downloading', { version: to }), p.progress !== undefined ? (
        <div className="h-1.5 w-48 overflow-hidden rounded-full bg-surface-tertiary"><div className="h-full bg-kraki-500" style={{ width: `${Math.round(p.progress * 100)}%` }} /></div>
      ) : undefined);
      case 'installing':
        return now - p.at > 180_000
          ? box('warn', t('update.notBack', { name: device.name }), t('update.checkComputer'))
          : box('info', device.online ? t('update.installing', { version: to }) : t('update.restarting', { name: device.name }), t('update.backSoon'));
      case 'updated': return box('ok', t('update.updated', { version: to }));
      case 'rolled_back': return box('warn', t('update.rolledBack'), p.from ? t('update.rolledBackDetail', { name: device.name, from: p.from }) : t('update.rolledBackDetailPrevious', { name: device.name }));
      case 'failed': return box('bad', t('update.failed'), (
        <span>{p.error ?? t('update.errorFallback')} <button type="button" className="underline" onClick={() => setUpdateProgress(device.id, null)}>{t('update.dismiss')}</button></span>
      ));
      default: return null;
    }
  }
}
