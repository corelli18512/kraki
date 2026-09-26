import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { BotMessageSquare, Download, MonitorCloud, Plus, Search, Settings, UserCog, X } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import { useNarrow } from '../../hooks/useNarrow';
import { SessionRow } from '../sessions/SessionRow';
import { NewSessionDialog } from '../sessions/NewSessionDialog';
import { ImportSessionDialog } from '../sessions/ImportSessionDialog';
import { DeviceGrid } from '../devices/DeviceGrid';
import { SettingsPanel } from './SettingsPanel';
import { ProfileBar } from './ProfileBar';
import './sidebar.css';

function Brand() {
  return (
    <span className="ksb-brand">
      <span className="ksb-wordmark">KRAKI</span>
      <span className="ksb-preview">Preview</span>
    </span>
  );
}

function useSortedSessions(query: string) {
  const sessions = useStore((s) => s.sessions);
  const pinned = useStore((s) => s.pinnedSessions);
  const previews = useStore((s) => s.sessionPreviews);
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...sessions.values()]
      .filter((s) => {
        if (!q) return true;
        const hay = `${s.title ?? ''} ${s.autoTitle ?? ''} ${s.deviceName ?? ''} ${previews.get(s.id)?.text ?? ''}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => {
        const pa = pinned.has(a.id) ? 0 : 1;
        const pb = pinned.has(b.id) ? 0 : 1;
        if (pa !== pb) return pa - pb;
        const ta = previews.get(a.id)?.timestamp ?? '';
        const tb = previews.get(b.id)?.timestamp ?? '';
        if (ta !== tb) return tb.localeCompare(ta);
        return a.id.localeCompare(b.id);
      });
  }, [sessions, pinned, previews, query]);
}

function EmptySessions({ onNew, onImport }: { onNew: () => void; onImport: () => void }) {
  const hasTentacle = useStore((s) => [...s.devices.values()].some((d) => d.role === 'tentacle' && d.online));
  return (
    <div className="ksb-empty">
      <BotMessageSquare className="ksb-empty-icon" strokeWidth={1.5} />
      <p className="ksb-empty-title">No sessions yet</p>
      <p className="ksb-empty-hint">{hasTentacle ? 'Start an agent on your connected device.' : 'Connect a device with the Kraki CLI to get started.'}</p>
      {hasTentacle ? (
        <div className="ksb-empty-actions">
          <button type="button" className="ksb-button is-primary" onClick={onNew}>New Session</button>
          <button type="button" className="ksb-button" onClick={onImport}><Download /> Import</button>
        </div>
      ) : <code className="ksb-code">npx @kraki/tentacle</code>}
    </div>
  );
}

export function Sidebar() {
  const narrow = useNarrow();
  const { sessionId } = useParams<{ sessionId: string }>();
  const pinned = useStore((s) => s.pinnedSessions);
  const status = useStore((s) => s.status);
  const reconnecting = useStore((s) => (s.status === 'disconnected' || s.status === 'connecting') && s.reconnectAttempts > 0);
  const [query, setQuery] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [plusMenu, setPlusMenu] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<'sessions' | 'devices' | 'settings'>('sessions');
  const [openSwipeId, setOpenSwipeId] = useState<string | null>(null);
  const navigate = useNavigate();
  const sorted = useSortedSessions(query);
  const total = useStore((s) => s.sessions.size);

  const list = total === 0
    ? <EmptySessions onNew={() => setNewOpen(true)} onImport={() => setImportOpen(true)} />
    : (
      <div className="ksb-list" role="list">
        {sorted.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            selected={session.id === sessionId}
            pinned={pinned.has(session.id)}
            narrow={narrow}
            openSwipeId={openSwipeId}
            setOpenSwipeId={setOpenSwipeId}
          />
        ))}
        {sorted.length === 0 && <p className="ksb-noresults">No sessions match “{query}”.</p>}
      </div>
    );

  const dialogs = (
    <>
      <NewSessionDialog open={newOpen} onClose={() => setNewOpen(false)} />
      <ImportSessionDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );

  if (!narrow) {
    return (
      <div className="ksb is-wide">
        <div className="ksb-top">
          <label className="ksb-search">
            <Search aria-hidden />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search sessions" />
            {query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><X /></button>}
          </label>
          <div className="ksb-plus-wrap">
            <button type="button" className="ksb-icon" aria-label="New session" aria-haspopup="menu" onClick={() => setPlusMenu((v) => !v)}><Plus /></button>
            {plusMenu && (
              <div className="ksb-plus-menu" role="menu" onMouseLeave={() => setPlusMenu(false)}>
                <button type="button" role="menuitem" onClick={() => { setPlusMenu(false); setNewOpen(true); }}><Plus /> New Session</button>
                <button type="button" role="menuitem" onClick={() => { setPlusMenu(false); setImportOpen(true); }}><Download /> Import Session…</button>
              </div>
            )}
          </div>
        </div>
        {reconnecting && <div className="ksb-status"><span className="kspinner ksb-spin" /> Reconnecting…</div>}
        {status === 'connecting' && !reconnecting && total === 0 && <div className="ksb-status"><span className="kspinner ksb-spin" /> Connecting…</div>}
        <div className="ksb-scroll">{list}</div>
        <div className="ksb-footer">
          <ProfileBar compact />
          <button type="button" className="ksb-icon" aria-label="Devices" title="Devices" onClick={() => navigate('/devices')}><MonitorCloud /></button>
          <button type="button" className="ksb-icon" aria-label="Settings" title="Settings" onClick={() => setSettingsOpen(true)}><Settings /></button>
        </div>
        <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        {dialogs}
      </div>
    );
  }

  return (
    <div className="ksb is-narrow">
      {tab === 'sessions' && (
        <>
          <div className="ksb-hero">
            <Brand />
            {reconnecting && <span className="kspinner ksb-spin" aria-label="Reconnecting" />}
          </div>
          <div className="ksb-scroll">{list}<div className="ksb-tabbar-space" /></div>
        </>
      )}
      {tab === 'devices' && <div className="ksb-scroll ksb-pane"><DeviceGrid /><div className="ksb-tabbar-space" /></div>}
      {tab === 'settings' && (
        <div className="ksb-scroll ksb-pane">
          <ProfileBar />
          <div className="p-4"><SettingsPanel open onClose={() => setTab('sessions')} inline /></div>
          <div className="ksb-tabbar-space" />
        </div>
      )}
      <nav className="ksb-tabbar" aria-label="Sections">
        <div className="ksb-tabs">
          {([
            ['sessions', 'Sessions', BotMessageSquare],
            ['devices', 'Devices', MonitorCloud],
            ['settings', 'Settings', UserCog],
          ] as const).map(([id, label, Icon]) => (
            <button key={id} type="button" className={`ksb-tab ${tab === id ? 'is-active' : ''}`} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
              <Icon strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <button type="button" className="ksb-fab" aria-label="New session" onClick={() => setNewOpen(true)}><Plus /></button>
      </nav>
      {dialogs}
    </div>
  );
}
