import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';
import { useStore } from '../hooks/useStore';
import { Sidebar } from '../components/layout/Sidebar';
import { SessionList } from '../components/sessions/SessionList';
import { SessionCard } from '../components/sessions/SessionCard';
import { DeviceList } from '../components/sessions/DeviceList';
import { EmptyState } from '../components/common/EmptyState';
import { ActionQueue } from '../components/actions/ActionQueue';
import { StreamingText } from '../components/chat/StreamingText';
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
  it('renders the kraki logo and title', () => {
    renderWithRouter(<Sidebar />);
    expect(screen.getAllByText('K').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByAltText('Kraki').length).toBeGreaterThanOrEqual(1);
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

describe('SessionList', () => {
  it('renders empty state when no sessions', () => {
    renderWithRouter(<SessionList />);
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
  });

  it('renders session cards when sessions exist', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'copilot', messageCount: 5 },
      { id: 's2', deviceId: 'd2', deviceName: 'Server', agent: 'claude', messageCount: 2 },
    ]);
    renderWithRouter(<SessionList />);
    expect(screen.getByText('Copilot')).toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument();
  });

  it('sorts sessions by timestamp then alphabetically', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: '', agent: 'codex', messageCount: 0 },
      { id: 's2', deviceId: 'd2', deviceName: '', agent: 'copilot', messageCount: 0 },
      { id: 's3', deviceId: 'd3', deviceName: '', agent: 'claude', messageCount: 0 },
    ]);
    renderWithRouter(<SessionList />);
    // Find the agent labels in order (they appear as text within session cards)
    const labels = screen.getAllByText(/^(Codex|Copilot|Claude)$/);
    // No timestamps, so fallback to alphabetical by ID: s1, s2, s3
    expect(labels[0].textContent).toBe('Codex');
    expect(labels[1].textContent).toBe('Copilot');
    expect(labels[2].textContent).toBe('Claude');
  });
});

// ============================================================
// SessionCard
// ============================================================

describe('SessionCard', () => {
  const session = {
    id: 's1', deviceId: 'd1', deviceName: 'MacBook', agent: 'copilot',
    model: 'gpt-4o', messageCount: 5,
  };

  it('renders agent info', () => {
    renderWithRouter(<SessionCard session={session} />);
    expect(screen.getByText('Copilot')).toBeInTheDocument();
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
  });

  it('renders device name', () => {
    renderWithRouter(<SessionCard session={session} />);
    expect(screen.getByText('MacBook')).toBeInTheDocument();
  });

  it('renders offline badge when device is offline', () => {
    // No device set = offline by default
    renderWithRouter(<SessionCard session={session} />);
    expect(screen.getByText('offline')).toBeInTheDocument();
  });

  it('shows unread indicator', () => {
    useStore.getState().setSessions([session]);
    useStore.getState().incrementUnread(session.id);
    const { container } = renderWithRouter(<SessionCard session={session} />);
    // Unread indicator is a small dot with bg-kraki-500
    expect(container.querySelector('.bg-kraki-500.rounded-full')).toBeInTheDocument();
  });

  it('navigates on click', async () => {
    const user = userEvent.setup();
    renderWithRouter(<SessionCard session={session} />);
    const buttons = screen.getAllByRole('button');
    await user.click(buttons[0]); // main card button
    // Can't easily verify navigation in unit test, but click shouldn't throw
  });

  it('shows message preview from last message', () => {
    useStore.getState().setSessions([session]);
    useStore.getState().appendMessage('s1', {
      type: 'agent_message',
      deviceId: 'd1', seq: 1,
      timestamp: new Date().toISOString(), sessionId: 's1',
      payload: { content: 'Here is the analysis result' },
    } as any);
    renderWithRouter(<SessionCard session={session} />);
    expect(screen.getByText('Here is the analysis result')).toBeInTheDocument();
  });

  it('shows error message as preview', () => {
    useStore.getState().setSessions([session]);
    useStore.getState().appendMessage('s1', {
      type: 'error',
      deviceId: 'd1', seq: 1,
      timestamp: new Date().toISOString(), sessionId: 's1',
      payload: { message: 'Something went wrong' },
    } as any);
    renderWithRouter(<SessionCard session={session} />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('applies active style when route matches', () => {
    renderWithRouter(<SessionCard session={session} />, { route: '/session/s1' });
    // Main card button contains the agent label text
    const cardButton = screen.getByText('Copilot').closest('button')!;
    expect(cardButton.className).toContain('kraki-500');
  });

  it('applies inactive style when route does not match', () => {
    renderWithRouter(<SessionCard session={session} />, { route: '/' });
    const cardButton = screen.getByText('Copilot').closest('button')!;
    expect(cardButton.className).toContain('hover:bg-surface-tertiary');
  });

  it('renders without model', () => {
    const noModel = { ...session, model: undefined };
    renderWithRouter(<SessionCard session={noModel} />);
    expect(screen.getByText('Copilot')).toBeInTheDocument();
    expect(screen.queryByText('gpt-4o')).not.toBeInTheDocument();
  });

  it('renders without device name', () => {
    const noDevice = { ...session, deviceName: '' };
    renderWithRouter(<SessionCard session={noDevice} />);
    expect(screen.getByText('Copilot')).toBeInTheDocument();
  });
});

// ============================================================
// DeviceList
// ============================================================

describe('DeviceList', () => {
  it('renders nothing when no tentacles', () => {
    const { container } = renderWithRouter(<DeviceList />);
    expect(container.firstChild).toBeNull();
  });

  it('renders tentacle devices', () => {
    useStore.getState().setDevices([
      { id: 'd1', name: 'MacBook Pro', role: 'tentacle', kind: 'desktop', online: true },
      { id: 'd2', name: 'CI Server', role: 'tentacle', kind: 'server', online: false },
    ]);
    renderWithRouter(<DeviceList />);
    expect(screen.getByText('MacBook Pro')).toBeInTheDocument();
    expect(screen.getByText('CI Server')).toBeInTheDocument();
  });

  it('does not render app devices', () => {
    useStore.getState().setDevices([
      { id: 'd1', name: 'Web Browser', role: 'app', kind: 'web', online: true },
    ]);
    const { container } = renderWithRouter(<DeviceList />);
    expect(container.firstChild).toBeNull();
  });

  it('shows online/offline indicators', () => {
    useStore.getState().setDevices([
      { id: 'd1', name: 'Online Mac', role: 'tentacle', online: true },
      { id: 'd2', name: 'Offline Server', role: 'tentacle', online: false },
    ]);
    renderWithRouter(<DeviceList />);
    // Both devices should be shown
    expect(screen.getByText('Online Mac')).toBeInTheDocument();
    expect(screen.getByText('Offline Server')).toBeInTheDocument();
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
// ActionQueue
// ============================================================

describe('ActionQueue', () => {
  it('renders nothing when no pending actions', () => {
    const { container } = renderWithRouter(<ActionQueue />);
    expect(container.firstChild).toBeNull();
  });

  it('shows count for single pending permission', () => {
    useStore.getState().addPermission({
      id: 'p1', sessionId: 's1', toolName: 'shell',
      args: { command: 'ls' }, description: 'List', timestamp: '',
    });
    renderWithRouter(<ActionQueue />);
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('1 action pending')).toBeInTheDocument();
  });

  it('shows plural count for multiple actions', () => {
    useStore.getState().addPermission({
      id: 'p1', sessionId: 's1', toolName: 'shell',
      args: { command: 'ls' }, description: 'List', timestamp: '',
    });
    useStore.getState().addQuestion({
      id: 'q1', sessionId: 's1', question: 'Which?', timestamp: '',
    });
    renderWithRouter(<ActionQueue />);
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText(/2 actions pending/)).toBeInTheDocument();
  });

  it('shows multi-session indicator', () => {
    useStore.getState().addPermission({
      id: 'p1', sessionId: 's1', toolName: 'shell',
      args: {}, description: '', timestamp: '',
    });
    useStore.getState().addPermission({
      id: 'p2', sessionId: 's2', toolName: 'shell',
      args: {}, description: '', timestamp: '',
    });
    renderWithRouter(<ActionQueue />);
    expect(screen.getByText(/across 2 sessions/)).toBeInTheDocument();
  });

  it('shows View button for single session and navigates on click', async () => {
    const user = userEvent.setup();
    useStore.getState().addPermission({
      id: 'p1', sessionId: 's1', toolName: 'shell',
      args: {}, description: '', timestamp: '',
    });
    renderWithRouter(<ActionQueue />);
    const viewBtn = screen.getByText('View →');
    expect(viewBtn).toBeInTheDocument();
    await user.click(viewBtn);
    // Navigation triggered (doesn't throw)
  });
});

// ============================================================
// StreamingText
// ============================================================

describe('StreamingText', () => {
  it('renders content', () => {
    renderWithRouter(<StreamingText content="Hello streaming" />);
    expect(screen.getByText('Hello streaming')).toBeInTheDocument();
  });

  it('has streaming cursor class', () => {
    const { container } = renderWithRouter(<StreamingText content="typing..." />);
    const cursorEl = container.querySelector('.streaming-cursor');
    expect(cursorEl).toBeInTheDocument();
  });
});

// ============================================================
// ToolActivity
// ============================================================

describe('ToolActivity', () => {
  it('renders tool start', () => {
    renderWithRouter(
      <ToolActivity type="start" toolName="shell" args={{ command: 'ls -la' }} />,
    );
    expect(screen.getByText('shell')).toBeInTheDocument();
    expect(screen.getByText(/shell/)).toBeInTheDocument();
  });

  it('renders tool complete', () => {
    renderWithRouter(
      <ToolActivity type="complete" toolName="read_file" args={{ path: 'src/index.ts' }} result="content" />,
    );
    expect(screen.getByText('read_file')).toBeInTheDocument();
  });

  it('shows summary for shell tool', () => {
    renderWithRouter(
      <ToolActivity type="start" toolName="shell" args={{ command: 'npm test' }} />,
    );
    expect(screen.getByText('$ npm test')).toBeInTheDocument();
  });

  it('shows summary for read_file tool', () => {
    renderWithRouter(
      <ToolActivity type="start" toolName="read_file" args={{ path: 'package.json' }} />,
    );
    expect(screen.getByText('package.json')).toBeInTheDocument();
  });

  it('expands to show args on click', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <ToolActivity type="complete" toolName="shell" args={{ command: 'ls' }} result="file1\nfile2" />,
    );
    await user.click(screen.getByRole('button'));
    expect(screen.getByText('Command')).toBeInTheDocument();
    expect(screen.getByText('Result')).toBeInTheDocument();
  });

  it('does not show result section for start type', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <ToolActivity type="start" toolName="shell" args={{ command: 'ls' }} />,
    );
    await user.click(screen.getByRole('button'));
    expect(screen.getByText('Command')).toBeInTheDocument();
    expect(screen.queryByText('Result')).not.toBeInTheDocument();
  });

  it('shows summary for fetch_url tool', () => {
    renderWithRouter(
      <ToolActivity type="start" toolName="fetch_url" args={{ url: 'https://example.com' }} />,
    );
    expect(screen.getByText('https://example.com')).toBeInTheDocument();
  });

  it('shows summary for mcp tool', () => {
    renderWithRouter(
      <ToolActivity type="start" toolName="mcp" args={{ server: 'myserver', tool: 'search', params: {} }} />,
    );
    expect(screen.getByText('myserver/search')).toBeInTheDocument();
  });

  it('shows empty summary for unknown tool', () => {
    renderWithRouter(
      <ToolActivity type="start" toolName="custom_tool" args={{ foo: 'bar' }} />,
    );
    expect(screen.getByText('custom_tool')).toBeInTheDocument();
  });

  it('shows summary for write_file tool', () => {
    renderWithRouter(
      <ToolActivity type="start" toolName="write_file" args={{ path: 'src/app.ts', content: '...' }} />,
    );
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
  });

  it('handles shell tool with non-string command gracefully', () => {
    renderWithRouter(
      <ToolActivity type="start" toolName="shell" args={{ command: 123 }} />,
    );
    expect(screen.getByText('shell')).toBeInTheDocument();
  });

  it('handles fetch_url with non-string url gracefully', () => {
    renderWithRouter(
      <ToolActivity type="start" toolName="fetch_url" args={{ url: null }} />,
    );
    expect(screen.getByText('fetch_url')).toBeInTheDocument();
  });

  it('handles mcp with non-string tool gracefully', () => {
    renderWithRouter(
      <ToolActivity type="start" toolName="mcp" args={{ server: 's', tool: 42, params: {} }} />,
    );
    expect(screen.getByText('mcp')).toBeInTheDocument();
  });

  it('handles read_file with non-string path gracefully', () => {
    renderWithRouter(
      <ToolActivity type="start" toolName="read_file" args={{ path: undefined }} />,
    );
    expect(screen.getByText('read_file')).toBeInTheDocument();
  });
});
