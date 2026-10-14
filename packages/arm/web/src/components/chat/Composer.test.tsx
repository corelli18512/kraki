import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Composer, updateComposerScrollFade } from './Composer';
import { useStartDictation } from './Voice';
import { outbox } from '../../lib/chat/outbox';
import { useStore } from '../../hooks/useStore';

vi.mock('./Voice', () => ({
  MicButton: () => null, VoiceError: () => null, VoiceRow: () => null, VoiceTranscript: () => null,
  useDictation: () => ({ active: false }), useStartDictation: vi.fn(() => vi.fn()),
}));

const props = { sessionId: 'composer-test', intent: 'prompt' as const, canAbort: false, reachable: true, busy: false, onSend: vi.fn(), onAbort: vi.fn() };

beforeEach(() => { useStore.getState().setDraft(props.sessionId, ''); vi.clearAllMocks(); });

describe('Composer', () => {
  it('clears the draft and restores editor focus', () => {
    useStore.getState().setDraft(props.sessionId, 'short');
    render(<Composer {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear draft' }));
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.getByRole('textbox')).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Clear draft' })).not.toBeInTheDocument();
  });

  it('disables attachment selection while retaining text steering', () => {
    render(<Composer {...props} busy canAbort intent="steer" />);
    expect(screen.getByRole('button', { name: 'Attach image' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'steer this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Steer agent' }));
    expect(props.onSend).toHaveBeenCalledWith('steer this', undefined, 'steer');
  });

  it('fades only scroll edges with hidden text', () => {
    const el = document.createElement('textarea');
    Object.defineProperties(el, { clientHeight: { value: 56 }, scrollHeight: { value: 200 } });
    updateComposerScrollFade(el);
    expect(el.style.maskImage).toContain('14px), transparent');
    el.scrollTop = 144;
    updateComposerScrollFade(el);
    expect(el.style.maskImage).toContain('to bottom, transparent');
    expect(el.style.maskImage).toContain('14px), #000');
    const short = document.createElement('textarea');
    updateComposerScrollFade(short);
    expect(short.style.maskImage).toBe('');
  });
});


describe('Composer — staged voice send', () => {
  it('clears the draft immediately and does not send until the staged completion', () => {
    outbox.reset();
    const send = vi.fn(async () => true);
    outbox.configure({ send, isDeliveryPathUp: () => true });
    useStore.getState().setDraft(props.sessionId, 'base');
    render(<Composer {...props} onStageVoice={(text, attachments) => outbox.stage(props.sessionId, text, { attachments })} />);
    const stage = vi.mocked(useStartDictation).mock.calls.at(-1)![3]!;
    let staged: ReturnType<typeof stage>;
    // Speech events arrive outside React's handler.
    act(() => { staged = stage('raw'); });
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(outbox.forSession(props.sessionId)[0]).toMatchObject({ state: 'correcting', text: 'base raw' });
    expect(send).not.toHaveBeenCalled();
    act(() => { staged!.complete('fixed', 'raw', true); });
    expect(outbox.forSession(props.sessionId)[0]).toMatchObject({ state: 'sending', text: 'base fixed' });
    expect(props.onSend).not.toHaveBeenCalled();
  });
});
