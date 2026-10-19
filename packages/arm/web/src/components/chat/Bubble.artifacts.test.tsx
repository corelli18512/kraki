import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Bubble } from './Bubble';
import { attachmentsOf, payloadOf } from '../../lib/chat/spine';
import { __resetForTests, markAwaitingPush } from '../../lib/attachments';
import { imageRef, report, rowsFor, scenarios, sessionId, stepCountCases } from './Bubble.artifacts.fixture';

beforeEach(() => {
  vi.useFakeTimers();
  // Pending real ref state prevents transport/IDB fallback; browser suite also
  // supplies verified chunks and proves the actual ready image preview.
  markAwaitingPush(imageRef, () => { throw new Error('Unexpected attachment pull'); });
});
afterEach(() => { cleanup(); __resetForTests(); vi.useRealTimers(); });

describe('Bubble rows F6/F7 desired artifact and persisted Steps invariants', () => {
  it.each(scenarios)('$id: renders projected media once and preserves callback identity', (spec) => {
    const rows = rowsFor(spec.raw);
    const outcome = rows.find((row) => row.kind === 'spine' && row.item.message.seq === 17)!;
    const onOpenSteps = vi.fn(), onOpenArtifact = vi.fn(), onAnswer = vi.fn();
    const source = spec.raw.find((message) => message.seq === 17)!;
    const originalPayload = { ...payloadOf(source) };
    const { container } = render(<>{rows.map((row) => <Bubble key={row.key} row={row} ctx={{ sessionId, hueSeed: sessionId, onOpenSteps, onOpenArtifact, onAnswer }} />)}</>);
    expect(screen.getByText('Initial prompt').closest('.kbubble-user')).not.toBeNull();
    expect(screen.queryAllByRole('button', { name: 'Open report Isolated report' })).toHaveLength(spec.reports);
    expect(container.querySelectorAll('[data-image-gallery]')).toHaveLength(spec.images);
    expect(screen.queryAllByRole('button', { name: 'Show steps' })).toHaveLength(Number(spec.steps));
    if (spec.prose) expect(screen.getByText(spec.prose)).toBeInTheDocument();
    else expect(container.querySelector('.krow-agent .kmd')).toBeNull();
    expect(screen.queryByText(/System notice|No reply/)).not.toBeInTheDocument();
    if (spec.reports) {
      fireEvent.click(screen.getByRole('button', { name: 'Open report Isolated report' }));
      expect(onOpenArtifact).toHaveBeenCalledTimes(1);
      expect(onOpenArtifact.mock.calls[0][0]).toBe(report);
    }
    if (spec.steps) {
      fireEvent.click(screen.getByRole('button', { name: 'Show steps' }));
      expect(onOpenSteps.mock.calls).toEqual([[17]]);
    }
    expect(payloadOf(source)).toStrictEqual(originalPayload);
    expect(outcome.kind).toBe('spine');
    if (outcome.kind === 'spine') {
      const projectedPayload = payloadOf(outcome.item.message);
      expect(Object.hasOwn(projectedPayload, 'steps')).toBe(Object.hasOwn(originalPayload, 'steps'));
      expect(projectedPayload.steps).toBe(originalPayload.steps);
    }
    if (spec.id === 'image-only') expect(container.querySelector('.kbubble-agent')).toBeNull();
    if (spec.id === 'plain-no-reply') expect(screen.getByTestId('steps-only-turn')).toBeInTheDocument();
    if (spec.id === 'question-control') {
      fireEvent.click(screen.getByRole('button', { name: 'Answer: Amber' }));
      expect(onAnswer.mock.calls).toEqual([['q', 'Amber']]);
    }
    if (spec.id.includes('projected') || spec.id === 'no-duplicate-refs') {
      expect(outcome.kind === 'spine' && attachmentsOf(outcome.item.message)).toEqual([report, imageRef]);
    }
  });

  it('models protocol-shaped historical no_reply without inventing optional fields or counts', () => {
    for (const count of stepCountCases) {
      const spec = scenarios.find((s) => s.id === `no-reply-${count.label}-both`)!;
      expect(spec.raw[1].payload).toStrictEqual({ kind: 'no_reply', ...count.payload });
      expect(spec.raw[2].payload).toStrictEqual({ turnArtifacts: [report, imageRef] });
    }
  });

  it('live prose keeps the live trace target rather than a durable sequence', () => {
    const onOpenSteps = vi.fn();
    render(<Bubble row={{ kind: 'live', key: '__live__', card: { text: 'Working', action: null } }} ctx={{ sessionId, hueSeed: sessionId, onOpenSteps }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show steps' }));
    expect(onOpenSteps.mock.calls).toEqual([[null]]);
  });

  it('same durable sequence updated from image-only to prose retains the persisted trace target', () => {
    const onOpenSteps = vi.fn();
    const ctx = { sessionId, hueSeed: sessionId, onOpenSteps };
    const imageOnly = rowsFor(scenarios.find((s) => s.id === 'image-only')!.raw)[1];
    const prose = rowsFor(scenarios.find((s) => s.id === 'prose-image')!.raw)[1];
    const { rerender } = render(<Bubble row={imageOnly} ctx={ctx} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show steps' }));
    rerender(<Bubble row={prose} ctx={ctx} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show steps' }));
    expect(onOpenSteps.mock.calls).toEqual([[17], [17]]);
  });
});
