/**
 * New session: one composer — Kraki for Mac's NewSessionComposer.
 *
 * A message box first: type what the agent should do and press Enter.
 * Computer, agent, model and reasoning are compact pills under the text,
 * remembered per computer/agent, so most people never touch them. Send needs
 * some text. `StartSessionView` is the idle pane (nothing selected) built
 * around it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentCapabilities, DeviceSummary, ReasoningEffort } from '@kraki/protocol';
import { ArrowUp, Monitor, Laptop, MoonStar, Smartphone, Check, ChevronDown } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import { wsClient } from '../../lib/ws-client';
import { desktop } from '../../lib/desktop';
import { AgentGlyph, agentLabel } from '../common/AgentAvatar';
import './new-session.css';

const LAST_DEVICE_KEY = 'kraki:last-device';
const AGENT_PREF_KEY = 'kraki:last-agent-by-device';
const MODEL_PREF_KEY = 'kraki:last-model';
const EFFORT_PREF_KEY = 'kraki:last-effort';

const readJson = <T,>(key: string): Record<string, T> => {
  try { return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, T>; } catch { return {}; }
};
const writeJson = (key: string, k: string, v: unknown) => {
  const all = readJson<unknown>(key);
  all[k] = v;
  localStorage.setItem(key, JSON.stringify(all));
};

/** Asks the composer to take focus and brighten its border ("+", Ctrl+N). */
export const FOCUS_COMPOSER_EVENT = 'kraki:focus-new-session-composer';
let nudgeRequestedAt = 0;
export function requestComposerFocus(): void {
  nudgeRequestedAt = Date.now();
  window.dispatchEvent(new Event(FOCUS_COMPOSER_EVENT));
}

export type AgentAvailability = 'ready' | 'connecting' | 'offline' | 'noAgents';

/** DeviceStore.agentAvailability on Mac/iOS. */
export function agentAvailability(device: DeviceSummary | undefined, agents: AgentCapabilities[] | undefined): AgentAvailability {
  if (agents && agents.length > 0) return 'ready';
  if (!device?.online) return 'offline';
  return agents === undefined ? 'connecting' : 'noAgents';
}

const EFFORT_LABEL: Record<ReasoningEffort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
const EFFORT_DETAIL: Record<ReasoningEffort, string> = {
  low: 'Fastest replies', medium: 'Balanced', high: 'Thinks longer on hard problems', xhigh: 'Most thorough, slowest', max: 'Most thorough, slowest',
};
const EFFORT_FILL: Record<ReasoningEffort, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 3 };

/** gauge.with.dots.needle.{0,33,67,100}percent */
function EffortGauge({ effort }: { effort?: ReasoningEffort }) {
  const level = effort ? EFFORT_FILL[effort] : 1;
  const angle = -150 + level * 40;
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M2.3 11.5a6.2 6.2 0 1 1 11.4 0" strokeLinecap="round" />
      <line x1="8" y1="9" x2={8 + 4.2 * Math.cos((angle * Math.PI) / 180)} y2={9 + 4.2 * Math.sin((angle * Math.PI) / 180)} strokeLinecap="round" />
      <circle cx="8" cy="9" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function useThisPCDeviceId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    if (!desktop?.builtIn) return;
    let live = true;
    void desktop.builtIn.state().then((s) => { if (live) setId(s?.deviceId ?? null); });
    return () => { live = false; };
  }, []);
  return id;
}

type Pill = 'device' | 'agent' | 'model' | 'effort';

function PillButton({ open, onOpen, enabled = true, children, testId, title }: {
  open: boolean; onOpen: () => void; enabled?: boolean; children: React.ReactNode; testId: string; title?: string;
}) {
  return (
    <button
      type="button"
      className={`ns-pill${enabled ? '' : ' ns-pill-static'}${open ? ' ns-pill-open' : ''}`}
      disabled={!enabled}
      onClick={onOpen}
      data-testid={testId}
      title={title}
    >
      {children}
      {enabled && <ChevronDown className="ns-pill-chevron" strokeWidth={3} />}
    </button>
  );
}

function Popover({ onClose, children, wide }: { onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    setTimeout(() => document.addEventListener('mousedown', down), 0);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, [onClose]);
  return <div ref={ref} className={wide ? 'ns-popover ns-popover-wide' : 'ns-popover'} role="listbox">{children}</div>;
}

function ChoiceRow({ title, detail, selected, enabled = true, mark, onClick }: {
  title: string; detail?: string | null; selected?: boolean; enabled?: boolean; mark?: React.ReactNode; onClick?: () => void;
}) {
  return (
    <button type="button" className="ns-choice" disabled={!enabled} onClick={onClick} role="option" aria-selected={!!selected}>
      {mark !== undefined && <span className="ns-choice-mark">{mark}</span>}
      <span className="ns-choice-text">
        <span className={enabled ? 'ns-choice-title' : 'ns-choice-title ns-choice-disabled'}>{title}</span>
        {detail && <span className="ns-choice-detail">{detail}</span>}
      </span>
      {selected && <Check className="ns-choice-check" strokeWidth={2.6} />}
    </button>
  );
}

function ChoiceSection({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="ns-section">
      {title && <div className="ns-section-title">{title}</div>}
      {children}
    </div>
  );
}

export function NewSessionComposer({ placeholder = 'Describe a task, e.g. \u201cFix the failing tests in my-app\u201d', minRows = 3, onCreated }: {
  placeholder?: string; minRows?: number; onCreated?: () => void;
}) {
  const devices = useStore((s) => s.devices);
  const deviceAgents = useStore((s) => s.deviceAgents);
  const localId = useThisPCDeviceId();
  const localName = desktop?.platform === 'win32' ? 'This PC' : 'This computer';

  const tentacles = useMemo(() => [...devices.values()].filter((d) => d.role === 'tentacle'), [devices]);
  const online = useMemo(() => tentacles.filter((d) => d.online), [tentacles]);
  const offline = useMemo(() => tentacles.filter((d) => !d.online), [tentacles]);

  const [text, setText] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<ReasoningEffort | undefined>();
  const [openPill, setOpenPill] = useState<Pill | null>(null);
  const [focused, setFocused] = useState(false);
  const [nudged, setNudged] = useState(false);
  const userPickedDevice = useRef(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const device = tentacles.find((d) => d.id === deviceId);
  const agents = deviceAgents.get(deviceId);
  const agentList = agents ?? [];
  const availability = agentAvailability(device, agents);
  const activeAgent = agentList.find((a) => a.id === agentId) ?? agentList[0];
  const models = activeAgent?.models ?? [];
  const modelDetails = activeAgent?.modelDetails ?? [];
  const modelName = useCallback((id: string) => modelDetails.find((d) => d.id === id)?.name ?? id, [modelDetails]);
  const detail = modelDetails.find((d) => d.id === model);
  const efforts = detail?.supportsReasoningEffort ? detail.supportedReasoningEfforts ?? [] : [];
  const canSubmit = !!text.trim() && availability === 'ready' && !!deviceId && !!agentId && !!model;

  // Last-used computer if online; else this PC if online; else any online one.
  const selectDefaults = useCallback(() => {
    const saved = localStorage.getItem(LAST_DEVICE_KEY);
    const next = online.find((d) => d.id === saved)?.id
      ?? online.find((d) => d.id === localId)?.id
      ?? online[0]?.id ?? tentacles[0]?.id ?? '';
    setDeviceId(next);
  }, [online, tentacles, localId]);

  // Computers come online after the composer appeared (first launch, a
  // restart, an update): until the user picks one by hand, keep the default
  // — last used, else this PC, else any online one — current.
  const onlineKey = online.map((d) => d.id).join(',');
  useEffect(() => {
    if (userPickedDevice.current && device?.online) return;
    selectDefaults();
  }, [onlineKey, localId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Device → agent (remembered per computer).
  const agentIds = agentList.map((a) => a.id).join(',');
  useEffect(() => {
    if (!deviceId) return;
    const saved = readJson<string>(AGENT_PREF_KEY)[deviceId];
    if (saved && agentList.some((a) => a.id === saved)) setAgentId(saved);
    else if (!agentList.some((a) => a.id === agentId)) setAgentId(agentList[0]?.id ?? '');
  }, [deviceId, agentIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Agent → model (remembered per computer + agent).
  useEffect(() => {
    if (!agentId) { setModel(''); return; }
    const saved = readJson<string>(MODEL_PREF_KEY)[`${deviceId}:${agentId}`];
    if (saved && models.includes(saved)) setModel(saved);
    else if (!models.includes(model)) setModel(models[0] ?? '');
  }, [deviceId, agentId, models.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Model → reasoning (remembered per model; Medium by default).
  useEffect(() => {
    if (!model || efforts.length === 0) { setEffort(undefined); return; }
    const saved = readJson<ReasoningEffort>(EFFORT_PREF_KEY)[model];
    if (saved && efforts.includes(saved)) setEffort(saved);
    else if (!effort || !efforts.includes(effort)) setEffort(efforts.includes('medium') ? 'medium' : efforts[0]);
  }, [model, efforts.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const nudge = useCallback(() => {
    nudgeRequestedAt = 0;
    textRef.current?.focus();
    setNudged(true);
    setTimeout(() => setNudged(false), 250);
  }, []);

  useEffect(() => {
    textRef.current?.focus();
    if (Date.now() - nudgeRequestedAt < 1000) nudge();
    const onFocus = () => nudge();
    window.addEventListener(FOCUS_COMPOSER_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_COMPOSER_EVENT, onFocus);
  }, [nudge]);

  // Grow with the text: minRows…10 lines.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const line = 20;
    el.style.height = `${Math.min(Math.max(el.scrollHeight, minRows * line), 10 * line)}px`;
  }, [text, minRows]);

  const submit = () => {
    if (!canSubmit) return;
    localStorage.setItem(LAST_DEVICE_KEY, deviceId);
    writeJson(AGENT_PREF_KEY, deviceId, agentId);
    writeJson(MODEL_PREF_KEY, `${deviceId}:${agentId}`, model);
    if (effort) writeJson(EFFORT_PREF_KEY, model, effort);
    wsClient.createSession({ targetDeviceId: deviceId, agentId, model, reasoningEffort: effort, prompt: text.trim() });
    setText('');
    onCreated?.();
  };

  const deviceLabel = device ? (device.id === localId ? localName : device.name) : 'Choose a computer';
  const close = () => setOpenPill(null);

  return (
    <div className="ns-composer-wrap">
      <div
        className={`ns-composer${focused ? ' ns-focused' : ''}${nudged ? ' ns-nudged' : ''}`}
        onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); textRef.current?.focus(); } }}
      >
        <textarea
          ref={textRef}
          className="ns-text"
          value={text}
          rows={minRows}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          data-testid="new-session-text"
        />
        <div className="ns-bar">
          <div className="ns-pill-wrap">
            <PillButton open={openPill === 'device'} onOpen={() => setOpenPill('device')} testId="new-session-device" title={device?.name}>
              <span className="ns-dot" style={{ background: device?.online ? '#34D399' : 'var(--color-text-muted)' }} />
              <span className="ns-pill-text">{deviceLabel}</span>
            </PillButton>
            {openPill === 'device' && (
              <Popover onClose={close}>
                <ChoiceSection title="Online">
                  {online.map((d) => (
                    <ChoiceRow
                      key={d.id}
                      title={d.id === localId ? localName : d.name}
                      detail={d.id === localId ? d.name : null}
                      selected={d.id === deviceId}
                      mark={d.id === localId ? <Laptop className="ns-online" /> : <Monitor className="ns-online" />}
                      onClick={() => { setDeviceId(d.id); userPickedDevice.current = true; close(); }}
                    />
                  ))}
                </ChoiceSection>
                {offline.length > 0 && (
                  <ChoiceSection title="Offline">
                    {offline.slice(0, 6).map((d) => (
                      <ChoiceRow key={d.id} title={d.name} detail="Open Kraki on it to use it" enabled={false} mark={<Monitor className="ns-offline" />} />
                    ))}
                    {offline.length > 6 && <div className="ns-more">and {offline.length - 6} more offline</div>}
                  </ChoiceSection>
                )}
              </Popover>
            )}
          </div>
          {availability === 'ready' && (
            <>
              <div className="ns-pill-wrap">
                <PillButton open={openPill === 'agent'} onOpen={() => setOpenPill('agent')} enabled={agentList.length > 1} testId="new-session-agent">
                  <AgentGlyph agent={agentId} size={13} />
                  <span className="ns-pill-text">{agentLabel(agentId)}</span>
                </PillButton>
                {openPill === 'agent' && (
                  <Popover onClose={close}>
                    {agentList.map((a) => {
                      const n = a.models?.length ?? 0;
                      return (
                        <ChoiceRow
                          key={a.id}
                          title={agentLabel(a.id)}
                          detail={`${n} ${n === 1 ? 'model' : 'models'}`}
                          selected={a.id === agentId}
                          mark={<AgentGlyph agent={a.id} size={15} />}
                          onClick={() => { setAgentId(a.id); close(); }}
                        />
                      );
                    })}
                  </Popover>
                )}
              </div>
              <div className="ns-pill-wrap">
                <PillButton open={openPill === 'model'} onOpen={() => setOpenPill('model')} enabled={models.length > 1} testId="new-session-model">
                  <span className="ns-pill-text">{model ? modelName(model) : 'Model'}</span>
                </PillButton>
                {openPill === 'model' && (
                  <Popover onClose={close}>
                    <div className="ns-scroll">
                      {models.map((m) => (
                        <ChoiceRow
                          key={m}
                          title={modelName(m)}
                          detail={modelName(m) === m ? null : m}
                          selected={m === model}
                          onClick={() => { setModel(m); writeJson(MODEL_PREF_KEY, `${deviceId}:${agentId}`, m); close(); }}
                        />
                      ))}
                    </div>
                  </Popover>
                )}
              </div>
              {efforts.length > 0 && (
                <div className="ns-pill-wrap">
                  <PillButton open={openPill === 'effort'} onOpen={() => setOpenPill('effort')} testId="new-session-effort">
                    <EffortGauge effort={effort} />
                    <span className="ns-pill-text">{effort ? `${EFFORT_LABEL[effort]} thinking` : 'Thinking'}</span>
                  </PillButton>
                  {openPill === 'effort' && (
                    <Popover onClose={close}>
                      {efforts.map((e) => (
                        <ChoiceRow
                          key={e}
                          title={EFFORT_LABEL[e]}
                          detail={EFFORT_DETAIL[e]}
                          selected={e === effort}
                          mark={<span className="ns-muted-mark"><EffortGauge effort={e} /></span>}
                          onClick={() => { setEffort(e); if (model) writeJson(EFFORT_PREF_KEY, model, e); close(); }}
                        />
                      ))}
                    </Popover>
                  )}
                </div>
              )}
            </>
          )}
          <span className="ns-spacer" />
          <button type="button" className="ns-send" disabled={!canSubmit} onClick={submit} title="Start session (Enter)" data-testid="new-session-create" aria-label="Start session">
            <ArrowUp strokeWidth={3} />
          </button>
        </div>
      </div>
      <StatusLine
        anyOnline={online.length > 0}
        availability={availability}
        deviceName={device?.name}
        isThisPC={!!localId && deviceId === localId}
      />
    </div>
  );
}

function StatusLine({ anyOnline, availability, deviceName, isThisPC }: {
  anyOnline: boolean; availability: AgentAvailability; deviceName?: string; isThisPC: boolean;
}) {
  if (!anyOnline) {
    return <div className="ns-hint"><MoonStar className="ns-hint-icon" />No computer is online. Open Kraki on a computer to start a session there.</div>;
  }
  if (availability === 'ready') return null;
  if (availability === 'connecting') {
    return <div className="ns-hint"><span className="ns-spinner" />Connecting to {deviceName ?? 'the computer'}…</div>;
  }
  if (availability === 'offline') {
    return <div className="ns-hint"><MoonStar className="ns-hint-icon" />{deviceName ?? 'This computer'} is offline. Pick another one above.</div>;
  }
  return <NoAgentsGuide deviceName={isThisPC ? 'this PC' : deviceName ?? 'this computer'} isThisPC={isThisPC} />;
}

const INSTALL_LINKS = [
  { id: 'claude', name: 'Claude Code', url: 'https://code.claude.com/docs/en/setup' },
  { id: 'codex', name: 'Codex', url: 'https://developers.openai.com/codex/cli' },
  { id: 'copilot', name: 'GitHub Copilot CLI', url: 'https://github.com/features/copilot/cli' },
  { id: 'pi', name: 'Pi', url: 'https://github.com/earendil-works/pi#readme' },
];

/** NoAgentsGuide on Mac: the selected computer runs, but has no coding agent. */
function NoAgentsGuide({ deviceName, isThisPC }: { deviceName: string; isThisPC: boolean }) {
  const [checking, setChecking] = useState(false);
  return (
    <div className="ns-noagents" data-testid="new-session-no-agents">
      <div className="ns-noagents-title">No coding agent on {deviceName}</div>
      <div className="ns-noagents-detail">
        {isThisPC
          ? 'Kraki works with the coding agents on your computer. Install one and sign in to it, then check again.'
          : 'Kraki works with the coding agents on that computer. Install one there, sign in to it, then restart Kraki on it.'}
      </div>
      <div className="ns-noagents-links">
        {INSTALL_LINKS.map((l) => (
          <a key={l.id} href={l.url} target="_blank" rel="noreferrer" className="ns-install">
            <AgentGlyph agent={l.id} size={13} />
            <span>{l.name}</span>
          </a>
        ))}
      </div>
      {isThisPC && desktop?.builtIn && (
        <button
          type="button"
          className="ns-check"
          disabled={checking}
          onClick={() => { setChecking(true); void desktop!.builtIn!.restart().finally(() => setTimeout(() => setChecking(false), 4000)); }}
        >
          {checking ? 'Checking…' : 'Check Again'}
        </button>
      )}
    </div>
  );
}

/**
 * The main window when no session is selected and Kraki is ready: a heading,
 * the composer, and a quiet way to add the phone (MacStartSessionView).
 */
export function StartSessionView({ firstTime, onConnectPhone }: { firstTime: boolean; onConnectPhone?: () => void }) {
  return (
    <div className="ns-start" data-testid="start-session">
      <div className="ns-start-inner">
        <h1 className="ns-start-title">{firstTime ? 'What should we work on first?' : "What's next?"}</h1>
        <div className="ns-start-composer"><NewSessionComposer /></div>
        {firstTime && onConnectPhone && (
          <button type="button" className="ns-phone-link" onClick={onConnectPhone}>
            <Smartphone className="ns-hint-icon" />Use Kraki on your phone too
          </button>
        )}
      </div>
    </div>
  );
}

