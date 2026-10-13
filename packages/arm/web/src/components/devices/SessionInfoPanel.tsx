import { useEffect, useRef, useState } from 'react';
import { modelDisplayName, sessionDisplayTitle } from '../../lib/session-status';
import { useStore } from '../../hooks/useStore';
import { wsClient } from '../../lib/ws-client';
import type { SessionSummary, SessionUsage, ModelDetail, ContextTier } from '@kraki/protocol';
import { Check, Copy, GitFork, Pencil, Trash2 } from 'lucide-react';
import { SettingsAlert } from '../layout/SettingsControls';
import '../layout/settings.css';
import './session-info.css';

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const value = n / (n < 1_000_000 ? 1000 : 1_000_000);
  return `${value.toFixed(value < 10 ? 1 : 0)}${n < 1_000_000 ? 'K' : 'M'}`;
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="ksi-row"><span>{label}</span><div>{children}</div></div>;
}
interface Props {
  session: SessionSummary & { createdAt?: string };
  usage?: SessionUsage;
  models?: string[];
  modelDetails?: ModelDetail[];
  onClose: () => void;
}
export function SessionInfoPanel({ session, usage, models, modelDetails, onClose }: Props) {
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
  const efforts = detail?.supportsReasoningEffort ? detail.supportedReasoningEfforts ?? [] : [];
  const selectedEffort = effort ?? detail?.defaultReasoningEffort ?? efforts[0];
  useEffect(() => { setEffort(session.reasoningEffort); }, [session.model, session.reasoningEffort]);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const saveTitle = () => { wsClient.renameSession(session.id, titleDraft.trim()); setEditing(false); };
  const contextRatio = usage?.contextTokens != null && detail?.contextWindow ? Math.min(1, usage.contextTokens / detail.contextWindow) : null;
  const created = session.createdAt ? new Date(session.createdAt.includes('T') ? session.createdAt : `${session.createdAt.replace(' ', 'T')}Z`) : null;
  return <div className="ksi-panel">
    <div className="ksi-header"><h2>Session Info</h2><button type="button" onClick={onClose}>Done</button></div>
    <div className="ksi-body">
      <section><h3>Session</h3><Row label="Title">{editing ? <input autoFocus aria-label="Session title" value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} onBlur={saveTitle} onKeyDown={(e) => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); } }} className="min-w-0 w-full bg-transparent text-right outline-none" maxLength={80} /> : <button type="button" className="flex min-w-0 items-center gap-1" onClick={() => { setTitleDraft(session.title ?? session.autoTitle ?? ''); setEditing(true); }}><span className="truncate">{sessionDisplayTitle(session)}</span><Pencil size={11} className="shrink-0 text-text-secondary" /></button>}</Row>
      <Row label="Session ID"><div className="ksi-id"><span title={session.id} aria-label={`Session ID ${session.id}`}>{session.id}</span><button type="button" aria-label={copied ? 'Session ID copied' : 'Copy Session ID'} onClick={() => { void navigator.clipboard.writeText(session.id).then(() => { clearTimeout(copyTimer.current); setCopied(true); setCopyError(false); copyTimer.current = setTimeout(() => setCopied(false), 1500); }).catch(() => setCopyError(true)); }}>{copied ? <><Check size={11} />Copied</> : <Copy size={11} />}</button></div></Row>{copyError && <p role="alert" className="text-xs text-red-500">Couldn’t copy Session ID.</p>}
      <Row label="Agent">{session.agent}</Row>
      <Row label="Model">{models?.length ? <select aria-label="Model" value={session.model ?? models[0]} onChange={(e) => { const next = modelDetails?.find((d) => d.id === e.target.value); const preferred = next?.defaultReasoningEffort ?? next?.supportedReasoningEfforts?.[0]; setEffort(preferred); setContextTier('default'); wsClient.setSessionModel(session.id, e.target.value, preferred); }}>{models.map((m) => <option key={m} value={m}>{modelDisplayName(m, [{ modelDetails }]) ?? m}</option>)}</select> : modelDisplayName(session.model, [{ modelDetails }]) ?? '—'}</Row>
      {efforts.length > 0 && <Row label="Thinking"><div className="ksi-efforts" role="radiogroup" aria-label="Thinking">{efforts.map((e) => <button type="button" role="radio" aria-checked={selectedEffort === e} key={e} onClick={() => { setEffort(e); wsClient.setSessionModel(session.id, session.model!, e, contextTier === 'long_context' ? contextTier : undefined); }}>{e === 'xhigh' ? 'XHigh' : e[0].toUpperCase() + e.slice(1)}</button>)}</div></Row>}
      {detail?.supportedContextTiers && detail.supportedContextTiers.length > 1 && <Row label="Context tier"><select aria-label="Context tier" value={contextTier} onChange={(e) => { const tier = e.target.value as ContextTier; setContextTier(tier); wsClient.setSessionModel(session.id, session.model!, selectedEffort, tier === 'long_context' ? tier : undefined); }}><option value="default">Default</option><option value="long_context">1M tokens</option></select></Row>}
      <Row label="Created">{created && !Number.isNaN(created.getTime()) ? created.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}</Row></section>
      {usage && <section><h3>Usage</h3>{usage.contextTokens != null && <><Row label="Context">{formatTokens(usage.contextTokens)}{detail?.contextWindow ? ` / ${formatTokens(detail.contextWindow)}  ·  ${Math.round((contextRatio ?? 0) * 100)}%` : ''}</Row>{contextRatio != null && <div role="progressbar" aria-label="Context usage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(contextRatio * 100)} className="ksi-progress"><div style={{ width: `${contextRatio * 100}%`, background: contextRatio >= .85 ? '#ef4444' : contextRatio >= .6 ? '#fbbf24' : '#34c759' }} /></div>}</>}
      <Row label="Input tokens">{formatTokens(usage.inputTokens)}</Row><Row label="Output tokens">{formatTokens(usage.outputTokens)}</Row><Row label="Cache read">{formatTokens(usage.cacheReadTokens)}</Row><Row label="Cache write">{formatTokens(usage.cacheWriteTokens)}</Row><hr className="border-border-primary" /><Row label="Total cost">${usage.totalCost.toFixed(usage.totalCost < .01 ? 4 : 3)}</Row><Row label="Duration">{usage.totalDurationMs < 60000 ? `${(usage.totalDurationMs / 1000).toFixed(1)}s` : `${Math.floor(usage.totalDurationMs / 60000)}m ${Math.floor(usage.totalDurationMs / 1000) % 60}s`}</Row></section>}
      {device && <section><h3>Device</h3><Row label="Name">{device.name}</Row><Row label="Status"><span className="flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full" style={{ background: device.online ? '#34c759' : '#808080' }} />{device.online ? 'Online' : 'Offline'}</span></Row>{version && <Row label="Version">{version}</Row>}</section>}
      <div className="ksi-actions"><button type="button" onClick={() => { wsClient.forkSession(session.id); onClose(); }}><GitFork size={16} />Fork</button><button type="button" onClick={() => setConfirmDelete(true)}><Trash2 size={16} />Delete</button></div>
    </div>
    {confirmDelete && <SettingsAlert title="Delete session?" body="This permanently deletes the session and its messages on this computer." confirm="Delete" onCancel={() => setConfirmDelete(false)} onConfirm={() => { wsClient.deleteSession(session.id); setConfirmDelete(false); onClose(); }} />}
  </div>;
}
