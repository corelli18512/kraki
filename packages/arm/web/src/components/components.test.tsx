import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';
import { useStore } from '../hooks/useStore';
import { Sidebar } from '../components/layout/Sidebar';
import { SessionRow } from '../components/sessions/SessionRow';
import { NewSessionDialog } from '../components/sessions/NewSessionDialog';
import type { ChatMessage } from '../types/store';
import { EmptyState } from '../components/common/EmptyState';
import { ToolActivity } from '../components/chat/ToolActivity';
import { ProfileBar } from '../components/layout/ProfileBar';

// Helper: wrap in MemoryRouter for components using react-router
function renderWithRouter(ui: React.ReactElement, { route = '/' } = {}) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/" element={ui} />
        <Route path="/session/:sessionId" element={ui} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useStore.getState().reset();
});

// ============================================================
// Sidebar
// ============================================================

describe('Sidebar', () => {
  it('wide: search and new session; lists sessions', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'pi', state: 'idle', messageCount: 1, title: 'Alpha' },
      { id: 's2', deviceId: 'd1', deviceName: 'Mac', agent: 'pi', state: 'idle', messageCount: 1, title: 'Beta' },
    ]);
    renderWithRouter(<Sidebar />);
    expect(screen.getByLabelText('Search sessions')).toBeInTheDocument();
    expect(screen.getByLabelText('New session')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });
});

describe('ProfileBar', () => {
  it('hides the profile bar for open auth', () => {
    useStore.getState().setUser({ id: 'u1', login: 'open-user', provider: 'open' });
    const { container } = renderWithRouter(<ProfileBar />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the profile bar for GitHub auth', () => {
    useStore.getState().setUser({ id: 'u1', login: 'octocat', provider: 'github', email: 'octo@example.com' });
    renderWithRouter(<ProfileBar />);
    expect(screen.getByText('octocat')).toBeInTheDocument();
    expect(screen.getByText('octo@example.com')).toBeInTheDocument();
  });
});

// ============================================================
// SessionList
// ============================================================

describe('SessionRow', () => {
  const session = {
    id: 's1', deviceId: 'd1', deviceName: 'MacBook', agent: 'pi' as const,
    model: 'gpt-5', state: 'idle' as const, messageCount: 5, title: 'Cache work',
  };
  const row = (props: Partial<React.ComponentProps<typeof SessionRow>> = {}) =>
    renderWithRouter(<SessionRow session={session} selected={false} pinned={false} narrow={false} {...props} />);

  it('title, device, model and the latest preview', () => {
    useStore.getState().setDevices([{ id: 'd1', name: 'MacBook', role: 'tentacle', online: true }]);
    useStore.getState().setSessionPreview('s1', { text: 'Done:\n  all  green', type: 'agent', timestamp: new Date().toISOString() });
    row();
    expect(screen.getByText('Cache work')).toBeInTheDocument();
    expect(screen.getByText('MacBook')).toBeInTheDocument();
    expect(screen.getByText('gpt-5')).toBeInTheDocument();
    expect(screen.getByText('Done: all green')).toBeInTheDocument();
    expect(screen.getByLabelText('Last message from agent')).toBeInTheDocument();
  });

  it('a waiting question and an offline device read as such', () => {
    useStore.getState().setDevices([{ id: 'd1', name: 'MacBook', role: 'tentacle', online: true }]);
    useStore.getState().setSessionPreview('s1', { text: 'Deploy?', type: 'question', timestamp: '' });
    const { unmount } = row();
    expect(screen.getByLabelText('Waiting for an answer')).toBeInTheDocument();
    unmount();
    useStore.getState().setDevices([{ id: 'd1', name: 'MacBook', role: 'tentacle', online: false }]);
    row();
    expect(screen.getByText('offline')).toBeInTheDocument();
    expect(screen.getByLabelText('Offline')).toBeInTheDocument();
  });

  it('unread dot unless selected; a draft previews as the draft', () => {
    useStore.getState().setSessions([{ ...session, lastSeq: 9, readSeq: 3 }]);
    useStore.getState().setDraft('s1', 'half typed');
    const { unmount } = row();
    expect(screen.getByLabelText('Unread')).toBeInTheDocument();
    expect(screen.getByText('half typed')).toBeInTheDocument();
    unmount();
    row({ selected: true });
    expect(screen.queryByLabelText('Unread')).toBeNull();
  });
});

describe('Sidebar sorting and search', () => {
  it('pinned first, then newest preview; search filters', async () => {
    const base = { deviceId: 'd1', deviceName: 'Mac', agent: 'pi' as const, state: 'idle' as const, messageCount: 1 };
    useStore.getState().setSessions([
      { ...base, id: 'a', title: 'Old' }, { ...base, id: 'b', title: 'New' }, { ...base, id: 'c', title: 'Pinned' },
    ]);
    useStore.getState().setSessionPreview('a', { text: 'x', type: 'agent', timestamp: '2026-01-01T00:00:00Z' });
    useStore.getState().setSessionPreview('b', { text: 'y', type: 'agent', timestamp: '2026-02-01T00:00:00Z' });
    useStore.getState().setPinnedSessions(new Set(['c']));
    renderWithRouter(<Sidebar />);
    const titles = screen.getAllByRole('button').map((b) => b.textContent ?? '').filter((t) => /Old|New|Pinned/.test(t));
    expect(titles.map((t) => t.match(/Old|New|Pinned/)?.[0])).toEqual(['Pinned', 'New', 'Old']);
    await userEvent.type(screen.getByLabelText('Search sessions'), 'old');
    expect(screen.queryByText('New')).toBeNull();
    expect(screen.getByText('Old')).toBeInTheDocument();
  });
});

describe('NewSessionDialog', () => {
  it('does not offer offline tentacles even if stale model metadata exists', () => {
    localStorage.removeItem('kraki:last-device');
    localStorage.removeItem('kraki:last-model');

    useStore.getState().setDevices([
      { id: 'd-offline', name: 'Offline Mac', role: 'tentacle', online: false },
    ]);
    useStore.getState().setDeviceAgents('d-offline', [{ type: 'code', id: 'copilot', models: ['gpt-5'] }]);

    renderWithRouter(<NewSessionDialog open onClose={() => {}} />);

    expect(screen.getByText('No devices online')).toBeInTheDocument();
    expect(screen.queryByText('Offline Mac')).not.toBeInTheDocument();
  });

  it('offers online tentacles even before device models arrive', () => {
    localStorage.removeItem('kraki:last-device');
    localStorage.removeItem('kraki:last-model');

    useStore.getState().setDevices([
      { id: 'd-online', name: 'Online Mac', role: 'tentacle', online: true },
    ]);

    renderWithRouter(<NewSessionDialog open onClose={() => {}} />);

    expect(screen.getByText('Online Mac')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. claude-sonnet-4')).toBeInTheDocument();
  });
});

// ============================================================
// EmptyState
// ============================================================

describe('EmptyState', () => {
  it('renders icon, title, and description', () => {
    renderWithRouter(
      <EmptyState icon="◈" title="No data" description="Nothing to show" />,
    );
    expect(screen.getByText('◈')).toBeInTheDocument();
    expect(screen.getByText('No data')).toBeInTheDocument();
    expect(screen.getByText('Nothing to show')).toBeInTheDocument();
  });
});

// ============================================================
// ToolActivity
// ============================================================

describe('ToolActivity', () => {
  const noopPull = () => {};

  it('renders tool start with headline', () => {
    renderWithRouter(
      <ToolActivity type="start" toolName="shell" headline="$ ls -la" sessionId="s1" requestPull={noopPull} />,
    );
    expect(screen.getByText('shell')).toBeInTheDocument();
    expect(screen.getByText('$ ls -la')).toBeInTheDocument();
  });

  it('renders tool complete with headline', () => {
    renderWithRouter(
      <ToolActivity type="complete" toolName="read_file" headline="src/index.ts" sessionId="s1" requestPull={noopPull} />,
    );
    expect(screen.getByText('read_file')).toBeInTheDocument();
    expect(screen.getByText('src/index.ts')).toBeInTheDocument();
  });

  it('renders empty headline gracefully', () => {
    renderWithRouter(
      <ToolActivity type="start" toolName="custom_tool" headline="" sessionId="s1" requestPull={noopPull} />,
    );
    expect(screen.getByText('custom_tool')).toBeInTheDocument();
  });

  it('expands to show body when clicked', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <ToolActivity type="complete" toolName="shell" headline="$ ls" sessionId="s1" requestPull={noopPull} />,
    );
    await user.click(screen.getByRole('button'));
    // Without refs, the body just echoes the headline under "Command" label
    expect(screen.getByText('Command')).toBeInTheDocument();
  });

  it('does not show result section without resultRef', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <ToolActivity type="start" toolName="shell" headline="$ ls" sessionId="s1" requestPull={noopPull} />,
    );
    await user.click(screen.getByRole('button'));
    expect(screen.queryByText('Result')).not.toBeInTheDocument();
  });

  it('renders tool with truncated headline', () => {
    renderWithRouter(
      <ToolActivity type="start" toolName="bash" headline={'$ ' + 'x'.repeat(197) + '…'} sessionId="s1" requestPull={noopPull} />,
    );
    expect(screen.getByText('bash')).toBeInTheDocument();
  });
});
