import { t } from '../../i18n';
import { formatDateTime, formatNumber } from '../../i18n/format';
import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
import { modelDisplayName, sessionDisplayTitle } from '../../lib/session-status';
import { useStore } from '../../hooks/useStore';
import { isImeComposing } from '../../lib/ime';
import { wsClient } from '../../lib/ws-client';
import type { SessionSummary, SessionUsage, ModelDetail, ContextTier } from '@kraki/protocol';
import { Check, Copy, GitFork, Pencil, Trash2 } from 'lucide-react';
import { SettingsAlert } from '../layout/SettingsControls';
import '../layout/settings.css';
import './session-info.css';

export function formatTokens(n: number): string {
  if (n < 1000) return formatNumber(n, { useGrouping: false });
  const value = n / (n < 1_000_000 ? 1000 : 1_000_000);
  return t(n < 1_000_000 ? 'devices:sessionInfo.thousands' : 'devices:sessionInfo.millions', { value: formatNumber(value, { minimumFractionDigits: value < 10 ? 1 : 0, maximumFractionDigits: value < 10 ? 1 : 0, useGrouping: false }) });
}
function Row({ label, children, grow }: { label: string; children: React.ReactNode; grow?: boolean }) {
  return (
    <div className={grow ? 'ksi-row ksi-row-grow' : 'ksi-row'}>
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}
interface Props {
  session: SessionSummary & { createdAt?: string };
  usage?: SessionUsage;
  models?: string[];
  modelDetails?: ModelDetail[];
  onClose: () => void;
}
export function SessionInfoPanel({ session, usage, models, modelDetails, onClose }: Props) {
  const { t } = useTranslation('devices');
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    rootRef.current?.querySelector('button')?.focus();
    return () => previous?.focus();
  }, []);
  const device = useStore((s) => s.devices.get(session.deviceId));
  const version = useStore((s) => s.deviceVersions.get(session.deviceId));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [effort, setEffort] = useState(session.reasoningEffort);
  const [contextTier, setContextTier] = useState<ContextTier>('default');
  const detail = modelDetails?.find((d) => d.id === session.model);
  const efforts = detail?.supportsReasoningEffort ? (detail.supportedReasoningEfforts ?? []) : [];
  const selectedEffort = effort ?? detail?.defaultReasoningEffort ?? efforts[0];
  useEffect(() => {
    setEffort(session.reasoningEffort);
  }, [session.model, session.reasoningEffort]);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const saveTitle = () => {
    wsClient.renameSession(session.id, titleDraft.trim());
    setEditing(false);
  };
  const contextRatio =
    usage?.contextTokens != null && detail?.contextWindow
      ? Math.min(1, usage.contextTokens / detail.contextWindow)
      : null;
  const created = session.createdAt
    ? new Date(session.createdAt.includes('T') ? session.createdAt : `${session.createdAt.replace(' ', 'T')}Z`)
    : null;
  return (
    <div
      className="ksi-panel"
      ref={rootRef}
      onKeyDown={(e) => {
        if (e.key !== 'Tab') return;
        const controls = [
          ...e.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled)',
          ),
        ];
        if (e.shiftKey && document.activeElement === controls[0]) {
          e.preventDefault();
          controls.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === controls.at(-1)) {
          e.preventDefault();
          controls[0]?.focus();
        }
      }}
    >
      <div className="ksi-header">
        <h2>{t('sessionInfo.title')}</h2>
        <button type="button" onClick={onClose}>
          {t('sessionInfo.done')}
        </button>
      </div>
      <div className="ksi-body">
        <section>
          <h3>{t('sessionInfo.session')}</h3>
          <Row label={t('sessionInfo.titleLabel')} grow={editing}>
            {editing ? (
              <input
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                aria-label={t('sessionInfo.sessionTitle')}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={(e) => {
                  if (isImeComposing(e)) return;
                  if (e.key === 'Enter') saveTitle();
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setEditing(false);
                  }
                }}
                className="ksi-title-input"
                maxLength={80}
              />
            ) : (
              <button
                type="button"
                className="flex min-w-0 items-center gap-1"
                onClick={() => {
                  setTitleDraft(session.title ?? session.autoTitle ?? '');
                  setEditing(true);
                }}
              >
                <span className="truncate">{sessionDisplayTitle(session)}</span>
                <Pencil size={11} className="shrink-0 text-text-secondary" />
              </button>
            )}
          </Row>
          <Row label={t('sessionInfo.id')}>
            <div className="ksi-id">
              <span title={session.id} aria-label={t('sessionInfo.idLabel', { id: session.id })}>
                {session.id}
              </span>
              <button
                type="button"
                aria-label={copied ? t('sessionInfo.idCopied') : t('sessionInfo.copyId')}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(session.id)
                    .then(() => {
                      clearTimeout(copyTimer.current);
                      setCopied(true);
                      setCopyError(false);
                      copyTimer.current = setTimeout(() => setCopied(false), 1500);
                    })
                    .catch(() => setCopyError(true));
                }}
              >
                {copied ? (
                  <>
                    <Check size={11} />
                    {t('sessionInfo.copied')}
                  </>
                ) : (
                  <Copy size={11} />
                )}
              </button>
            </div>
          </Row>
          {copyError && (
            <p role="alert" className="text-xs text-red-500">
              {t('sessionInfo.copyFailed')}
            </p>
          )}
          <Row label={t('sessionInfo.agent')}>{session.agent}</Row>
          <Row label={t('sessionInfo.model')}>
            {models?.length ? (
              <select
                aria-label={t('sessionInfo.model')}
                value={session.model ?? models[0]}
                onChange={(e) => {
                  const next = modelDetails?.find((d) => d.id === e.target.value);
                  const preferred = next?.defaultReasoningEffort ?? next?.supportedReasoningEfforts?.[0];
                  setEffort(preferred);
                  setContextTier('default');
                  wsClient.setSessionModel(session.id, e.target.value, preferred);
                }}
              >
                {models.map((m) => (
                  <option key={m} value={m}>
                    {modelDisplayName(m, [{ modelDetails }]) ?? m}
                  </option>
                ))}
              </select>
            ) : (
              (modelDisplayName(session.model, [{ modelDetails }]) ?? '—')
            )}
          </Row>
          {efforts.length > 0 && (
            <Row label={t('sessionInfo.thinking')}>
              <div className="ksi-efforts" role="radiogroup" aria-label={t('sessionInfo.thinking')}>
                {efforts.map((e) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selectedEffort === e}
                    key={e}
                    onClick={() => {
                      setEffort(e);
                      wsClient.setSessionModel(
                        session.id,
                        session.model!,
                        e,
                        contextTier === 'long_context' ? contextTier : undefined,
                      );
                    }}
                  >
                    {t(`sessionInfo.effort.${e}`, { defaultValue: e })}
                  </button>
                ))}
              </div>
            </Row>
          )}
          {detail?.supportedContextTiers && detail.supportedContextTiers.length > 1 && (
            <Row label={t('sessionInfo.contextTier')}>
              <select
                aria-label={t('sessionInfo.contextTier')}
                value={contextTier}
                onChange={(e) => {
                  const tier = e.target.value as ContextTier;
                  setContextTier(tier);
                  wsClient.setSessionModel(
                    session.id,
                    session.model!,
                    selectedEffort,
                    tier === 'long_context' ? tier : undefined,
                  );
                }}
              >
                <option value="default">{t('sessionInfo.default')}</option>
                <option value="long_context">{t('sessionInfo.longContext')}</option>
              </select>
            </Row>
          )}
          <Row label={t('sessionInfo.created')}>
            {created && !Number.isNaN(created.getTime())
              ? formatDateTime(created, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })
              : '—'}
          </Row>
        </section>
        {usage && (
          <section>
            <h3>{t('sessionInfo.usage')}</h3>
            {usage.contextTokens != null && (
              <>
                <Row label={t('sessionInfo.context')}>
                  {formatTokens(usage.contextTokens)}
                  {detail?.contextWindow
                    ? ` / ${formatTokens(detail.contextWindow)}  ·  ${formatNumber(contextRatio ?? 0, { style: 'percent', maximumFractionDigits: 0 })}`
                    : ''}
                </Row>
                {contextRatio != null && (
                  <div
                    role="progressbar"
                    aria-label={t('sessionInfo.contextUsage')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(contextRatio * 100)}
                    className="ksi-progress"
                  >
                    <div
                      style={{
                        width: `${contextRatio * 100}%`,
                        background: contextRatio >= 0.85 ? '#ef4444' : contextRatio >= 0.6 ? '#fbbf24' : '#34c759',
                      }}
                    />
                  </div>
                )}
              </>
            )}
            <Row label={t('sessionInfo.input')}>{formatTokens(usage.inputTokens)}</Row>
            <Row label={t('sessionInfo.output')}>{formatTokens(usage.outputTokens)}</Row>
            <Row label={t('sessionInfo.cacheRead')}>{formatTokens(usage.cacheReadTokens)}</Row>
            <Row label={t('sessionInfo.cacheWrite')}>{formatTokens(usage.cacheWriteTokens)}</Row>
            <hr className="border-border-primary" />
            <Row label={t('sessionInfo.cost')}>{`$${usage.totalCost.toFixed(usage.totalCost < 0.01 ? 4 : 3)}`}</Row>
            <Row label={t('sessionInfo.duration')}>
              {usage.totalDurationMs < 60000
                ? t('sessionInfo.seconds', { seconds: formatNumber(usage.totalDurationMs / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false }) })
                : t('sessionInfo.minutesSeconds', { minutes: formatNumber(Math.floor(usage.totalDurationMs / 60000), { useGrouping: false }), seconds: formatNumber(Math.floor(usage.totalDurationMs / 1000) % 60, { useGrouping: false }) })}
            </Row>
          </section>
        )}
        {device && (
          <section>
            <h3>{t('sessionInfo.device')}</h3>
            <Row label={t('sessionInfo.name')}>{device.name}</Row>
            <Row label={t('sessionInfo.status')}>
              <span className="flex items-center gap-1">
                <i className={`h-1.5 w-1.5 rounded-full${device.online ? ' ksi-online-dot' : ''}`} style={device.online ? undefined : { background: '#808080' }} />
                {device.online ? t('sessionInfo.online') : t('sessionInfo.offline')}
              </span>
            </Row>
            {version && <Row label={t('sessionInfo.version')}>{version}</Row>}
          </section>
        )}
        <div className="ksi-actions">
          <button
            type="button"
            onClick={() => {
              wsClient.forkSession(session.id);
              onClose();
            }}
          >
            <GitFork size={16} />
            {t('sessionInfo.fork')}
          </button>
          <button type="button" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={16} />
            {t('sessionInfo.delete')}
          </button>
        </div>
      </div>
      {confirmDelete && (
        <SettingsAlert
          title={t('sessionInfo.deleteTitle')}
          body={t('sessionInfo.deleteBody')}
          confirm={t('sessionInfo.delete')}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            wsClient.deleteSession(session.id);
            setConfirmDelete(false);
            onClose();
          }}
        />
      )}
    </div>
  );
}
