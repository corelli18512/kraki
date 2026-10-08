/**
 * The coding agents on this PC, as found by the built-in Kraki
 * (`kraki agents --json`) — the Windows twin of Kraki for Mac's
 * LocalAgentsPanel: installed agents only, each with its state and hint, and
 * every supported agent one click away in "Supported agents".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentCheckEvent, BuiltInBridge } from '../../lib/desktop';
import './desktop-setup.css';

export type AgentStatus = 'checking' | 'ready' | 'needs_login' | 'not_installed' | 'error';

export interface AgentResult {
  id: string;
  name: string;
  status: AgentStatus;
  version?: string;
  models: number;
  hint?: string;
  installUrl?: string;
}

export const AGENT_CATALOG = [
  { id: 'claude', name: 'Claude Code', maker: 'Anthropic', blurb: "Anthropic's coding agent.", detect: 'Found as `claude` in a terminal.', installUrl: 'https://code.claude.com/docs/en/setup' },
  { id: 'codex', name: 'Codex', maker: 'OpenAI', blurb: "OpenAI's coding agent.", detect: 'Found as `codex` in a terminal.', installUrl: 'https://developers.openai.com/codex/cli' },
  { id: 'copilot', name: 'GitHub Copilot CLI', maker: 'GitHub', blurb: 'GitHub Copilot in the terminal. Needs a Copilot plan.', detect: 'Found as `copilot` in a terminal.', installUrl: 'https://github.com/features/copilot/cli' },
  { id: 'pi', name: 'Pi', maker: 'Earendil', blurb: 'An open coding agent that works with many model providers and your own API keys.', detect: 'Found as `pi` in a terminal.', installUrl: 'https://github.com/earendil-works/pi#readme' },
];

/** Hints from the CLI say "Terminal" (macOS wording); Windows has terminals. */
const windowsHint = (hint?: string) => hint?.replace(/\bin Terminal\b/g, 'in a terminal');

/** Run the check; results update as each agent reports. */
export function useAgentsCheck(builtIn: BuiltInBridge) {
  const [agents, setAgents] = useState<Map<string, AgentResult>>(new Map());
  const [running, setRunning] = useState(false);
  const [hasResults, setHasResults] = useState(false);
  const runId = useRef(0);

  const run = useCallback(() => {
    const id = ++runId.current;
    setRunning(true);
    setAgents((prev) => {
      const next = new Map(prev);
      for (const [k, a] of next) if (a.status !== 'not_installed') next.set(k, { ...a, status: 'checking' });
      return next;
    });
    void builtIn.checkAgents((e: AgentCheckEvent) => {
      if (id !== runId.current) return;
      if (e.event === 'checking') {
        setAgents((prev) => new Map(prev).set(e.id, { ...(prev.get(e.id) ?? { models: 0 }), id: e.id, name: e.name, status: 'checking' }));
      } else if (e.event === 'agent') {
        setAgents((prev) => new Map(prev).set(e.id, { id: e.id, name: e.name, status: e.status, version: e.version, models: e.models, hint: windowsHint(e.hint), installUrl: e.installUrl }));
      }
    }).finally(() => {
      if (id !== runId.current) return;
      setRunning(false);
      setHasResults(true);
    });
  }, [builtIn]);

  useEffect(() => { run(); return () => { runId.current++; }; }, [run]);

  const all = [...agents.values()];
  const installed = all.filter((a) => a.status !== 'not_installed');
  const readyCount = all.filter((a) => a.status === 'ready').length;
  return { agents, installed, readyCount, running, hasResults, run };
}

export function detailLine(a: AgentResult): string | null {
  switch (a.status) {
    case 'checking': return null;
    case 'ready': return `Ready · ${a.models} ${a.models === 1 ? 'model' : 'models'}`;
    case 'needs_login': return `Not signed in. ${a.hint ?? ''}`.trim();
    case 'not_installed': return 'Not installed';
    case 'error': return a.hint ?? "Couldn't start.";
  }
}

export function StatusIcon({ status }: { status: AgentStatus }) {
  if (status === 'checking') return <span className="ds-spinner ds-spinner-mini" aria-label="Checking" />;
  if (status === 'ready') {
    return (
      <svg className="ds-icon ds-icon-ready" viewBox="0 0 16 16" aria-label="Ready"><circle cx="8" cy="8" r="7.5" /><path d="M4.6 8.3l2.2 2.2 4.6-4.8" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    );
  }
  if (status === 'not_installed') {
    return <svg className="ds-icon ds-icon-dashed" viewBox="0 0 16 16" aria-label="Not installed"><circle cx="8" cy="8" r="6.5" /></svg>;
  }
  return (
    <svg className="ds-icon ds-icon-warn" viewBox="0 0 16 16" aria-label="Needs attention"><circle cx="8" cy="8" r="7.5" /><path d="M8 4.2v4.6" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" /><circle cx="8" cy="11.4" r="1" fill="#fff" /></svg>
  );
}

type Check = ReturnType<typeof useAgentsCheck>;

export function AgentsPanel({ check }: { check: Check }) {
  const [catalogOpen, setCatalogOpen] = useState(false);
  const summary = check.running ? 'Checking…'
    : check.readyCount === 0 ? (check.installed.length === 0 ? '' : 'No agent is ready yet.')
      : check.readyCount === 1 ? 'Ready to use.' : `${check.readyCount} agents ready.`;

  return (
    <div className="ds-agents">
      {!check.hasResults && check.installed.length === 0 ? (
        <div className="ds-agents-loading"><span className="ds-spinner" /> Looking for coding agents on this PC…</div>
      ) : check.installed.length === 0 ? (
        <div className="ds-agents-none" data-testid="desktop-agents-none">
          <div className="ds-strong">No coding agent found on this PC yet.</div>
          <div className="ds-muted">Kraki runs agents like Claude Code, Codex, GitHub Copilot CLI or Pi. Install one, sign in to it, then click Check Again.</div>
          <button type="button" className="ds-button ds-button-small" onClick={() => setCatalogOpen(true)}>Choose an agent to install…</button>
        </div>
      ) : (
        <div>
          {check.installed.map((a, i) => (
            <div key={a.id}>
              {i > 0 && <div className="ds-divider" />}
              <div className="ds-agent" data-testid={`desktop-agent-${a.id}`}>
                <StatusIcon status={a.status} />
                <div className="ds-agent-text">
                  <div><span className="ds-agent-name">{a.name}</span>{a.version && <span className="ds-agent-version">{a.version}</span>}</div>
                  {detailLine(a) && <div className={a.status === 'ready' ? 'ds-agent-detail ds-agent-detail-ready' : 'ds-agent-detail'}>{detailLine(a)}</div>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="ds-agents-footer">
        <span className="ds-muted">{summary}</span>
        <span className="ds-spacer" />
        {check.installed.length > 0 && (
          <button type="button" className="ds-link" onClick={() => setCatalogOpen(true)}>Supported agents</button>
        )}
        <button type="button" className="ds-button ds-button-small" disabled={check.running} onClick={check.run}>Check Again</button>
      </div>
      {catalogOpen && <SupportedAgentsSheet check={check} onClose={() => setCatalogOpen(false)} />}
    </div>
  );
}

function SupportedAgentsSheet({ check, onClose }: { check: Check; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === 'Enter') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="ds-sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ds-sheet" role="dialog" aria-modal="true" aria-label="Supported coding agents">
        <div className="ds-sheet-title">Supported coding agents</div>
        <div className="ds-muted ds-sheet-detail">Kraki runs the agents you install on this PC, with your own accounts. Install an agent and sign in to it once in a terminal, then click Check Again.</div>
        <div>
          {AGENT_CATALOG.map((entry, i) => {
            const a = check.agents.get(entry.id);
            const status: AgentStatus = a?.status ?? 'checking';
            const line = !a || status === 'checking' ? 'Checking…'
              : status === 'not_installed' ? 'Not installed on this PC.'
                : `Installed${a.version ? ` ${a.version}` : ''} — ${detailLine(a) ?? ''}`;
            return (
              <div key={entry.id}>
                {i > 0 && <div className="ds-divider" />}
                <div className="ds-catalog-row">
                  <StatusIcon status={status} />
                  <div className="ds-agent-text">
                    <div><span className="ds-agent-name">{entry.name}</span><span className="ds-agent-version">{entry.maker}</span></div>
                    <div className="ds-agent-detail ds-agent-detail-ready">{entry.blurb}</div>
                    <div className={status === 'ready' ? 'ds-agent-detail ds-ok' : 'ds-agent-detail'}>{line}</div>
                    {status === 'not_installed' && <div className="ds-agent-detail">{entry.detect}</div>}
                  </div>
                  {status === 'not_installed' && (
                    <a className="ds-button ds-button-small" href={a?.installUrl ?? entry.installUrl} target="_blank" rel="noreferrer">Install guide</a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="ds-sheet-actions">
          {check.running && <><span className="ds-spinner" /><span className="ds-muted">Checking…</span></>}
          <span className="ds-spacer" />
          <button type="button" className="ds-button" disabled={check.running} onClick={check.run}>Check Again</button>
          <button type="button" className="ds-button ds-button-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
