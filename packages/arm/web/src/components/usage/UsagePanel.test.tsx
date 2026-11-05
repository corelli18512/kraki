import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { UsageRing, devicesNeedingUsageUpdate } from './UsagePanel';
import type { DeviceSummary } from '@kraki/protocol';

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

describe('devicesNeedingUsageUpdate (K-084)', () => {
  const device = (id: string, name: string): DeviceSummary => ({ id, name, role: 'tentacle', online: true });
  it('does not tell a computer with account usage turned off to update', () => {
    const devices = new Map([['old', device('old', 'Old Mac')], ['off', device('off', 'Usage Off')], ['new', device('new', 'New Mac')]]);
    const features: Record<string, string[]> = { old: [], off: ['account_usage_off'], new: ['account_usage'] };
    const outdated = devicesNeedingUsageUpdate(devices.values(), new Map(), (id, f) => features[id]?.includes(f));
    expect(outdated.map((d) => d.id)).toEqual(['old']);
  });
});
