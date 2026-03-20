import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBanner } from './ErrorBanner';
import { useStore } from '../../hooks/useStore';

describe('ErrorBanner', () => {
  it('renders nothing when no error', () => {
    useStore.setState({ lastError: null });
    const { container } = render(<ErrorBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('renders error message when lastError is set', () => {
    useStore.setState({ lastError: 'Target device is not online' });
    render(<ErrorBanner />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Target device is not online')).toBeInTheDocument();
  });

  it('clears error on dismiss', () => {
    useStore.setState({ lastError: 'Something failed' });
    render(<ErrorBanner />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Dismiss error'));
    expect(useStore.getState().lastError).toBeNull();
  });
});
