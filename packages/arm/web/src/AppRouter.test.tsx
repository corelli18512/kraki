import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Route, Routes, useNavigate, useParams } from 'react-router';
import type { ReactNode } from 'react';
import { AppRouter } from './AppRouter';

function Open() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/session/b')}>open b</button>;
}

/** Click outside act(), then read the DOM after microtasks but before the
 *  next task: urgent (sync) renders have committed, transitions have not. */
async function openAndReadBeforeNextTask(Router: (props: { children: ReactNode }) => ReactNode): Promise<string> {
  window.history.replaceState(null, '', '/session/a');
  const view = render(
    <Router>
      <Open />
      <Routes><Route path="/session/:id" element={<SessionId />} /></Routes>
    </Router>,
  );
  const previous = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  try {
    screen.getByRole('button', { name: 'open b' }).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    return `${window.location.pathname} shows ${screen.getByTestId('chat').textContent}`;
  } finally {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previous;
    view.unmount();
  }
}

function SessionId() {
  const { id } = useParams();
  return <p data-testid="chat">{id}</p>;
}

describe('AppRouter (K-240)', () => {
  it('never shows the previous chat under the new URL', async () => {
    // React Router 7's stock BrowserRouter renders the route change as a
    // transition ('/session/b shows a' here); AppRouter must not.
    expect(await openAndReadBeforeNextTask(AppRouter)).toBe('/session/b shows b');
  });
});
