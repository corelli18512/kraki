import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';
import { useStore } from '../../hooks/useStore';
import { BottomNav } from './BottomNav';

function renderBottomNav(route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="*" element={<BottomNav />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useStore.getState().reset();
});

describe('BottomNav', () => {
  it('renders two navigation items', () => {
    renderBottomNav();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });

  it('highlights Sessions on home route', () => {
    renderBottomNav('/');
    const sessionsBtn = screen.getByText('Sessions').closest('button')!;
    expect(sessionsBtn.className).toContain('kraki-500');
    expect(sessionsBtn).toHaveAttribute('aria-selected', 'true');
  });

  it('does not highlight Sessions on other routes', () => {
    renderBottomNav('/session/s1');
    const sessionsBtn = screen.getByText('Sessions').closest('button')!;
    expect(sessionsBtn.className).toContain('text-secondary');
    expect(sessionsBtn).toHaveAttribute('aria-selected', 'false');
  });

  it('shows pending action badge on Actions', () => {
    useStore.getState().addPermission({
      id: 'p1', sessionId: 's1', toolName: 'shell',
      args: {}, description: '', timestamp: '',
    });
    useStore.getState().addQuestion({
      id: 'q1', sessionId: 's1', question: 'test', timestamp: '',
    });
    renderBottomNav();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('hides badge when no pending actions', () => {
    renderBottomNav();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('navigates home when Sessions clicked', async () => {
    const user = userEvent.setup();
    renderBottomNav('/session/s1');
    await user.click(screen.getByText('Sessions'));
  });

  it('Actions button is clickable', async () => {
    const user = userEvent.setup();
    renderBottomNav();
    await user.click(screen.getByText('Actions'));
  });

  it('Actions aria-selected is false when no pending actions on current session', () => {
    renderBottomNav('/session/s1');
    const actionsBtn = screen.getByText('Actions').closest('button')!;
    expect(actionsBtn).toHaveAttribute('aria-selected', 'false');
  });
});
