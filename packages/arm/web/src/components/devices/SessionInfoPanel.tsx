import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { useStore } from '../../hooks/useStore';
import { wsClient } from '../../lib/ws-client';
import type { SessionSummary, SessionUsage, ModelDetail } from '@kraki/protocol';
import { MessageSquare, GitFork, Trash2, Pencil } from 'lucide-react';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

interface Props {
  session: SessionSummary;
  usage?: SessionUsage;
  models?: string[];
  modelDetails?: ModelDetail[];
  onClose: () => void;
}

export function SessionInfoPanel({ session, usage, models, modelDetails, onClose }: Props) {
  const navigate = useNavigate();
  const mode = useStore((s) => s.sessionModes.get(session.id) ?? 'discuss');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [pendingEffort, setPendingEffort] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);

  const activeModel = pendingModel ?? session.model;
  const activeModelDetail = modelDetails?.find((d) => d.id === activeModel);
  const hasUsage = usage && (usage.inputTokens > 0 || usage.outputTokens > 0);

  const openPicker = () => {
    setPendingModel(session.model ?? null);
    setPendingEffort(undefined);
    setShowModelPicker(true);
  };

  const cancelPicker = () => {
    setShowModelPicker(false);
    setPendingModel(null);
    setPendingEffort(undefined);
  };

  const applyModel = () => {
    if (pendingModel) {
      wsClient.setSessionModel(session.id, pendingModel, pendingEffort);
    }
    setShowModelPicker(false);
    setPendingModel(null);
    setPendingEffort(undefined);
  };

  const sessionName = session.title ?? session.autoTitle ?? `${session.agent}${session.model ? ` · ${session.model}` : ''}`;

  const startEditing = useCallback(() => {
    setTitleDraft(session.title ?? session.autoTitle ?? '');
    setEditing(true);
  }, [session.title, session.autoTitle]);

  useEffect(() => {
    if (editing) titleInputRef.current?.focus();
  }, [editing]);

  const saveTitle = useCallback(() => {
    wsClient.renameSession(session.id, titleDraft.trim());
    setEditing(false);
  }, [session.id, titleDraft]);

  return (
    <div className="flex h-full flex-col">
      {/* Header — tappable to rename */}
      <div className="shrink-0 px-5 py-3">
        <div className="flex items-center gap-1.5">
          <button
            onClick={onClose}
            className="mr-0.5 text-text-secondary hover:text-text-primary sm:hidden"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          {editing ? (
            <input
              ref={titleInputRef}
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveTitle();
                if (e.key === 'Escape') setEditing(false);
              }}
              className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-text-primary outline-none border-b border-kraki-400"
              placeholder="Session title…"
              maxLength={80}
            />
          ) : (
            <button
              onClick={startEditing}
              className="group flex min-w-0 items-center gap-1.5"
            >
              <span className="truncate text-sm font-semibold text-text-primary">{sessionName}</span>
              <Pencil className="h-3 w-3 shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 space-y-4">
        {/* Info rows */}
        <div className="space-y-1.5">
          <div className="flex justify-between text-[11px]">
            <span className="text-text-muted">Agent</span>
            <span className="font-medium text-text-secondary">{session.agent}</span>
          </div>
          <div className="flex justify-between text-[11px]">
            <span className="text-text-muted">Status</span>
            <span className="font-medium text-text-secondary capitalize">{session.state}</span>
          </div>
          <div className="flex justify-between text-[11px]">
            <span className="text-text-muted">Mode</span>
            <span className="font-medium text-text-secondary capitalize">{mode}</span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-text-muted">ID</span>
            <span className="font-mono text-[10px] text-text-muted truncate ml-2">{session.id}</span>
          </div>
        </div>

        {/* Model — same row style as above, value has bg to imply clickable */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-text-muted">Model</span>
            <button
              onClick={() => models && models.length > 1 ? (showModelPicker ? cancelPicker() : openPicker()) : undefined}
              className={`rounded-md px-2 font-medium transition-colors ${
                models && models.length > 1
                  ? 'bg-ocean-500/10 text-text-secondary hover:bg-ocean-500/20 cursor-pointer'
                  : 'text-text-secondary cursor-default'
              }`}
            >
              {session.model ?? 'Unknown'}
            </button>
          </div>
          {showModelPicker && models && (
            <>
              <div className="max-h-40 overflow-y-auto rounded-lg border border-border-primary bg-surface-secondary">
                {models.map((m) => (
                  <button
                    key={m}
                    onClick={() => setPendingModel(m)}
                    className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors ${
                      activeModel === m
                        ? 'bg-ocean-500/15 text-ocean-400 font-medium'
                        : 'text-text-secondary hover:bg-surface-tertiary hover:text-text-primary'
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activeModel === m ? 'bg-ocean-400' : 'bg-transparent'}`} />
                    {m}
                  </button>
                ))}
              </div>
              {activeModelDetail?.supportsReasoningEffort && activeModelDetail.supportedReasoningEfforts && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-text-muted">Thinking</span>
                  {activeModelDetail.supportedReasoningEfforts.map((effort) => (
                    <button
                      key={effort}
                      onClick={() => setPendingEffort(effort)}
                      className={`rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        (pendingEffort ?? activeModelDetail.defaultReasoningEffort) === effort
                          ? 'bg-ocean-500/15 text-ocean-400'
                          : 'bg-surface-tertiary text-text-secondary hover:bg-surface-tertiary/80 hover:text-text-primary'
                      }`}
                    >
                      {effort === 'xhigh' ? 'Max' : effort.charAt(0).toUpperCase() + effort.slice(1)}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  onClick={cancelPicker}
                  className="rounded-md px-2.5 py-1 text-[10px] font-medium text-text-muted transition-colors hover:bg-surface-tertiary hover:text-text-secondary"
                >
                  Cancel
                </button>
                <button
                  onClick={applyModel}
                  className="rounded-md bg-ocean-500 px-2.5 py-1 text-[10px] font-medium text-white transition-colors hover:bg-ocean-600"
                >
                  Apply
                </button>
              </div>
            </>
          )}
        </div>

        {/* Token usage */}
        {hasUsage && (
          <div className="space-y-1">
            <div className="flex justify-between text-[11px]">
              <span className="text-text-muted">Input</span>
              <span className="font-medium text-text-secondary">{formatTokens(usage.inputTokens)}</span>
            </div>
            <div className="flex justify-between text-[11px]">
              <span className="text-text-muted">Output</span>
              <span className="font-medium text-text-secondary">{formatTokens(usage.outputTokens)}</span>
            </div>
            {usage.cacheReadTokens > 0 && (
              <div className="flex justify-between text-[11px]">
                <span className="text-text-muted">Cache read</span>
                <span className="text-text-secondary">{formatTokens(usage.cacheReadTokens)}</span>
              </div>
            )}
            {usage.cacheWriteTokens > 0 && (
              <div className="flex justify-between text-[11px]">
                <span className="text-text-muted">Cache write</span>
                <span className="text-text-secondary">{formatTokens(usage.cacheWriteTokens)}</span>
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="space-y-1">
          <button
            onClick={() => { navigate(`/session/${session.id}`); onClose(); }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-text-secondary transition-colors hover:bg-surface-tertiary hover:text-text-primary"
          >
            <MessageSquare className="h-3.5 w-3.5" /> Open chat
          </button>
          <button
            onClick={() => { wsClient.forkSession(session.id); onClose(); }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-text-secondary transition-colors hover:bg-surface-tertiary hover:text-text-primary"
          >
            <GitFork className="h-3.5 w-3.5" /> Fork session
          </button>
          <button
            onClick={() => setConfirmDelete(true)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-red-500 transition-colors hover:bg-red-500/10"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete session
          </button>
        </div>
      </div>

      {/* Confirm delete dialog */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setConfirmDelete(false)}
          onKeyDown={(e) => e.key === 'Escape' && setConfirmDelete(false)}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
        >
          <div
            className="mx-4 w-full max-w-sm rounded-xl border border-border-primary bg-surface-primary p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-text-primary">Delete session?</h3>
            <p className="mt-2 text-xs text-text-secondary">
              This will permanently delete this session and all its messages.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(false)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-tertiary"
              >
                Cancel
              </button>
              <button
                onClick={() => { wsClient.deleteSession(session.id); setConfirmDelete(false); onClose(); }}
                className="rounded-lg bg-red-700 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-800"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
