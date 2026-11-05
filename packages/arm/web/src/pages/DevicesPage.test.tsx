import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import { useStore } from '../hooks/useStore';
import { DevicesPage } from './DevicesPage';

beforeEach(() => { useStore.getState().reset(); });

// K-212: the narrow Devices back button has an accessible name (axe button-name).
it('labels the back button (K-212)', () => {
  render(<MemoryRouter><DevicesPage /></MemoryRouter>);
  expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
});
