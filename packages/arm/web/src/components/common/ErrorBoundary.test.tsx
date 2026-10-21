import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { i18next } from '../../i18n';
import { ErrorBoundary } from './ErrorBoundary';

function Broken(): never { throw new Error('External error details'); }

afterEach(async () => { await i18next.changeLanguage('en'); vi.restoreAllMocks(); });

describe('ErrorBoundary localization', () => {
  it('updates fallback actions live and preserves external error details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary><Broken /></ErrorBoundary>);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    await act(async () => { await i18next.changeLanguage('zh-Hans'); });
    expect(screen.getByText('出了点问题')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(screen.getByText('External error details')).toBeInTheDocument();
  });
});
