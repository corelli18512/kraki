import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { AccountUsage, DeviceSummary } from '@kraki/protocol';
import { useStore } from '../../hooks/useStore';
import { OPEN_USAGE_EVENT, UsageRing, UsagePanel } from './UsagePanel';

vi.mock('../../lib/ws-client', () => ({ wsClient: { deviceHasFeature: () => true, refreshAccountUsage: vi.fn() } }));

const quota = (remainingPercent: number) => ({ id: 'weekly', kind: 'weekly', remainingPercent });

describe('UsageRing native dark amber gradient', () => {
  it('calibrates dark amber interpolation without changing light endpoints', () => {
    const { container } = render(<UsageRing window={quota(24)} stale={false} size={88} lineWidth={8} animateIn={false} />);
    const gradients = container.querySelectorAll('linearGradient');
    expect(gradients[0].querySelectorAll('stop')).toHaveLength(2);
    const stops = gradients[1].querySelectorAll('stop');
    expect(stops).toHaveLength(3);
    expect(stops[0]).toHaveClass('ur-c0');
    expect(stops[1]).toHaveAttribute('offset', '0.85');
    expect(stops[1]).toHaveAttribute('stop-color', '#ff9115');
    expect(stops[2]).toHaveClass('ur-c1');
    const arc = container.querySelector('.ur-arc')!;
    expect(arc).toHaveAttribute('stroke', `url(#${gradients[0].id})`);
    expect((arc as SVGElement).style.getPropertyValue('--ur-dark-gradient')).toBe(`url(#${gradients[1].id})`);
  });
  it('gives each ring its own gradient so multiple ring paint servers cannot collide', () => {
    const { container } = render(<><UsageRing window={quota(24)} stale={false} size={88} lineWidth={8} animateIn={false} /><UsageRing window={quota(40)} stale={false} size={88} lineWidth={8} animateIn={false} /></>);
    const ids = [...container.querySelectorAll('linearGradient')].map(e => e.id);
    expect(new Set(ids).size).toBe(4);
  });
});

describe('account tile staleness (K-233)', () => {
  beforeEach(() => { useStore.getState().reset(); });
  function renderTile(account: AccountUsage) {
    const mac: DeviceSummary = { id: 'Mac', name: 'Mac', role: 'tentacle', online: true };
    useStore.setState({
      devices: new Map([['Mac', mac]]),
      deviceUsage: new Map([['Mac', { accounts: [account], receivedAt: Date.now() }]]),
    });
    const view = render(<MemoryRouter><UsagePanel /></MemoryRouter>);
    act(() => { window.dispatchEvent(new Event(OPEN_USAGE_EVENT)); });
    return view.baseElement;
  }
  const limited = (fetchedAgoMs: number): AccountUsage => ({
    accountKey: 'a', provider: 'claude', error: 'rate_limited',
    windows: [{ id: 'w', kind: 'weekly', remainingPercent: 50 }],
    fetchedAt: new Date(Date.now() - fetchedAgoMs).toISOString(),
  });

  it('a failed refresh right after a fresh reading greys neither the badge nor the rings', () => {
    const root = renderTile(limited(10_000));
    expect(root.querySelector('.ua-stale')).toBeNull();
    expect(root.querySelector('.ur-num.is-stale')).toBeNull();
  });

  it('an old reading shows the Stale badge and greyed rings together', () => {
    const root = renderTile(limited(48 * 3_600_000));
    expect(root.querySelector('.ua-stale')).not.toBeNull();
    expect(root.querySelector('.ur-num.is-stale')).not.toBeNull();
  });
});
