import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Composer, pastedImage, updateComposerScrollFade } from './Composer';
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

describe('Composer — Stop latch settles (no permanent spinner)', () => {
  const stopProps = { ...props, sessionId: 'composer-stop', canAbort: true };
  const stop = () => screen.getByRole('button', { name: 'Stop agent' });
  beforeEach(() => { useStore.getState().setDraft(stopProps.sessionId, ''); });

  it('latches after click and ignores repeat clicks while pending', () => {
    const onAbort = vi.fn();
    render(<Composer {...stopProps} onAbort={onAbort} />);
    fireEvent.click(stop());
    expect(stop()).toBeDisabled();
    fireEvent.click(stop());
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it('becomes actionable again when the Stop could not be dispatched', () => {
    let refuse: () => void = () => {};
    render(<Composer {...stopProps} onAbort={(r) => { refuse = r; }} />);
    fireEvent.click(stop());
    expect(stop()).toBeDisabled();
    act(() => refuse());
    expect(stop()).toBeEnabled();
  });

  it('becomes actionable again when the Tentacle reports the abort failed', () => {
    render(<Composer {...stopProps} />);
    fireEvent.click(stop());
    expect(stop()).toBeDisabled();
    act(() => useStore.getState().appendMessage(stopProps.sessionId, {
      type: 'error', deviceId: 'dev-t', seq: 0, timestamp: new Date().toISOString(),
      sessionId: stopProps.sessionId, payload: { message: 'Failed to abort session: boom' },
    } as never));
    expect(stop()).toBeEnabled();
  });

  it('settles on going offline and is actionable after reconnect while the turn is still running', () => {
    const { rerender } = render(<Composer {...stopProps} />);
    fireEvent.click(stop());
    rerender(<Composer {...stopProps} reachable={false} />);
    rerender(<Composer {...stopProps} reachable />);
    expect(stop()).toBeEnabled();
  });

  it('a refusal for a previous session does not unlatch the current one', () => {
    let refuseOld: () => void = () => {};
    const { rerender } = render(<Composer {...stopProps} onAbort={(r) => { refuseOld = r; }} />);
    fireEvent.click(stop());
    rerender(<Composer {...stopProps} sessionId="composer-stop-2" onAbort={vi.fn()} />);
    fireEvent.click(stop());
    expect(stop()).toBeDisabled();
    act(() => refuseOld());
    expect(stop()).toBeDisabled();
  });
});

describe('Composer — images in answers (Mac ComposerAnswerImages)', () => {
  const ans = { ...props, sessionId: 'composer-answer', intent: 'answerQuestion' as const, busy: true };
  beforeEach(() => { useStore.getState().setDraft(ans.sessionId, ''); });

  async function attach() {
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    const OriginalImage = window.Image;
    // jsdom cannot decode images: stub the compression path.
    class FakeImage { width = 10; height = 10; onload: (() => void) | null = null; set src(_v: string) { setTimeout(() => this.onload?.(), 0); } }
    (window as unknown as { Image: unknown }).Image = FakeImage;
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,AAAA');
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} } as never);
    const U = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };
    const saved = [U.createObjectURL, U.revokeObjectURL];
    U.createObjectURL = () => 'blob:x'; U.revokeObjectURL = () => {};
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
      await new Promise((r) => setTimeout(r, 20));
    });
    (window as unknown as { Image: unknown }).Image = OriginalImage;
    toDataURL.mockRestore(); [U.createObjectURL, U.revokeObjectURL] = saved;
  }

  it('Pi: attach stays available while answering and an image-only answer can be sent with the image', async () => {
    const onSend = vi.fn();
    render(<Composer {...ans} agent="pi" onSend={onSend} />);
    expect(screen.getByRole('button', { name: 'Attach image' })).toBeEnabled();
    await attach();
    const send = screen.getByRole('button', { name: 'Submit answer' });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledWith('[image]', [expect.objectContaining({ type: 'image' })], 'answerQuestion');
  });

  it('Claude: attach is off while answering; a staged image is not sent and stays for later', async () => {
    const onSend = vi.fn();
    // Stage an image while idle, then a Claude question arrives.
    const view = render(<Composer {...props} sessionId={ans.sessionId} agent="claude" onSend={onSend} />);
    await attach();
    view.rerender(<Composer {...ans} agent="claude" onSend={onSend} />);
    expect(screen.getByRole('button', { name: 'Replace image' })).toBeDisabled();
    // Image alone is not an answer.
    expect(screen.getByRole('button', { name: 'Submit answer' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Amber' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }));
    expect(onSend).toHaveBeenCalledWith('Amber', undefined, 'answerQuestion');
    // Still staged for the next message.
    expect(screen.getByRole('button', { name: 'Replace image' })).toBeInTheDocument();
  });
});

/** jsdom cannot decode images: stub decoding (`decodes`) and canvas encoding. */
function stubImagePipeline(decodes: boolean) {
  const OriginalImage = window.Image;
  class FakeImage {
    width = 0; height = 0; onload: (() => void) | null = null; onerror: (() => void) | null = null;
    set src(_v: string) { setTimeout(() => { if (decodes) { this.width = 10; this.height = 10; this.onload?.(); } else this.onerror?.(); }, 0); }
  }
  (window as unknown as { Image: unknown }).Image = FakeImage;
  const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,AAAA');
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} } as never);
  const U = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };
  const saved = [U.createObjectURL, U.revokeObjectURL];
  U.createObjectURL = () => 'blob:x'; U.revokeObjectURL = () => {};
  return {
    toDataURL,
    restore() {
      (window as unknown as { Image: unknown }).Image = OriginalImage;
      toDataURL.mockRestore(); getContext.mockRestore(); [U.createObjectURL, U.revokeObjectURL] = saved;
    },
  };
}

async function pick(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
    await new Promise((r) => setTimeout(r, 50));
  });
}

describe('Composer — image errors and formats (K-200)', () => {
  const imgProps = { ...props, sessionId: 'composer-image' };
  beforeEach(() => { useStore.getState().setLastError(null); sessionStorage.clear(); });

  it('a corrupt or undecodable image says it cannot be read, not that it is too large', async () => {
    const stub = stubImagePipeline(false);
    try {
      render(<Composer {...imgProps} />);
      await pick(new File(['not an image'], 'broken.heic', { type: 'image/heic' }));
    } finally { stub.restore(); }
    expect(useStore.getState().lastError).toBe("This image can't be read here. Try a JPEG, PNG, GIF or WebP image.");
    expect(screen.getByRole('button', { name: 'Attach image' })).toBeInTheDocument();
  });

  it('a decodable HEIC is re-encoded as JPEG, never sent as HEIC', async () => {
    const stub = stubImagePipeline(true);
    const onSend = vi.fn();
    try {
      render(<Composer {...imgProps} onSend={onSend} />);
      await pick(new File(['heic'], 'photo.heic', { type: 'image/heic' }));
      expect(stub.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.8);
    } finally { stub.restore(); }
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSend).toHaveBeenCalledWith('[image]', [expect.objectContaining({ mimeType: 'image/jpeg' })], 'prompt');
  });

  it('a GIF within the limit is sent as is, keeping its animation', async () => {
    const stub = stubImagePipeline(true);
    const onSend = vi.fn();
    try {
      render(<Composer {...imgProps} onSend={onSend} />);
      await pick(new File(['GIF89a'], 'cat.gif', { type: 'image/gif' }));
      expect(stub.toDataURL).not.toHaveBeenCalled();
    } finally { stub.restore(); }
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSend).toHaveBeenCalledWith('[image]', [{ type: 'image', mimeType: 'image/gif', data: btoa('GIF89a') }], 'prompt');
  });
});

/** A clipboard with `files` and a `text/plain` string. */
function clipboard(files: File[], text = ''): DataTransfer {
  return { files, getData: (type: string) => (type === 'text/plain' ? text : '') } as unknown as DataTransfer;
}

describe('Composer — paste: text wins over an image (K-217, Mac MacComposerPastePolicy)', () => {
  const png = new File(['png'], 'image.png', { type: 'image/png' });
  beforeEach(() => { sessionStorage.clear(); });

  it('decides between the text and the image', () => {
    expect(pastedImage(clipboard([png]))).toBe(png);
    expect(pastedImage(clipboard([png], 'Q1\t42\nQ2\t57'))).toBeUndefined();
    expect(pastedImage(clipboard([png], 'https://example.com/cat.png'))).toBe(png);
    expect(pastedImage(clipboard([png], 'image.png'))).toBe(png);
    expect(pastedImage(clipboard([png], ' \uFFFC '))).toBe(png);
    expect(pastedImage(clipboard([], 'text only'))).toBeUndefined();
    expect(pastedImage(clipboard([new File(['x'], 'a.pdf', { type: 'application/pdf' })]))).toBeUndefined();
  });

  it('pasting text with a picture of it keeps the text and attaches nothing', async () => {
    render(<Composer {...props} sessionId="composer-paste" />);
    const allowed = fireEvent.paste(screen.getByRole('textbox'), { clipboardData: clipboard([png], 'Q1 42') });
    expect(allowed).toBe(true);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.getByRole('button', { name: 'Attach image' })).toBeInTheDocument();
  });

  it('pasting an image alone attaches it instead of inserting anything', async () => {
    const stub = stubImagePipeline(true);
    try {
      render(<Composer {...props} sessionId="composer-paste" />);
      const allowed = fireEvent.paste(screen.getByRole('textbox'), { clipboardData: clipboard([png]) });
      expect(allowed).toBe(false);
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    } finally { stub.restore(); }
    expect(screen.getByRole('button', { name: 'Replace image' })).toBeInTheDocument();
  });
});

describe('Composer — the staged image survives a reload (K-202)', () => {
  beforeEach(() => { sessionStorage.clear(); });

  it('restores the image for its Session after a remount, and not in another Session', async () => {
    const stub = stubImagePipeline(true);
    let view: ReturnType<typeof render>;
    try {
      view = render(<Composer {...props} sessionId="composer-reload" />);
      await pick(new File(['png'], 'a.png', { type: 'image/png' }));
    } finally { stub.restore(); }
    expect(screen.getByRole('button', { name: 'Replace image' })).toBeInTheDocument();
    view!.unmount();

    // A discarded tab reloads with only its sessionStorage.
    const restored = render(<Composer {...props} sessionId="composer-reload" />);
    expect(screen.getByRole('button', { name: 'Replace image' })).toBeInTheDocument();
    restored.unmount();

    render(<Composer {...props} sessionId="composer-other" />);
    expect(screen.getByRole('button', { name: 'Attach image' })).toBeInTheDocument();
  });

  it('switching Sessions still clears the staged image (WEB-168, by design); sending forgets it', async () => {
    const stub = stubImagePipeline(true);
    let view: ReturnType<typeof render>;
    try {
      view = render(<Composer {...props} sessionId="composer-reload" />);
      await pick(new File(['png'], 'a.png', { type: 'image/png' }));
    } finally { stub.restore(); }
    view!.rerender(<Composer {...props} sessionId="composer-other" />);
    expect(screen.getByRole('button', { name: 'Attach image' })).toBeInTheDocument();
    view!.rerender(<Composer {...props} sessionId="composer-reload" />);
    expect(screen.getByRole('button', { name: 'Attach image' })).toBeInTheDocument();
    expect(sessionStorage.getItem('kraki-composer-image')).toBeNull();

    const again = stubImagePipeline(true);
    try { await pick(new File(['png'], 'a.png', { type: 'image/png' })); } finally { again.restore(); }
    expect(sessionStorage.getItem('kraki-composer-image')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(sessionStorage.getItem('kraki-composer-image')).toBeNull();
  });
});
