import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Composer } from './Composer';
import { cancelDictation, finishDictation, useVoice } from '../../lib/voice/voice';

vi.mock('./Voice', () => ({
  MicButton: () => null, VoiceError: () => null, VoiceRow: () => null, VoiceTranscript: () => null,
  useDictation: () => ({ active: false }), useStartDictation: () => vi.fn(),
}));
vi.mock('../../lib/voice/voice', async (original) => ({
  ...await original<typeof import('../../lib/voice/voice')>(),
  finishDictation: vi.fn(), cancelDictation: vi.fn(),
}));

const props = { intent: 'prompt' as const, canAbort: false, reachable: true, busy: false, onSend: vi.fn(), onAbort: vi.fn() };

beforeEach(() => { vi.clearAllMocks(); useVoice.setState({ owner: null, phase: 'idle', staged: false }); });

describe('Composer — leaving a session while dictating (K-224)', () => {
  it('stops the microphone and keeps what was heard in that session’s draft', () => {
    const view = render(<Composer {...props} sessionId="a" />);
    useVoice.setState({ owner: 'a', phase: 'recording', rawText: 'half a thought' });
    view.unmount();
    expect(finishDictation).toHaveBeenCalledWith('edit');
  });
  it('cancels a recording that has not connected yet', () => {
    const view = render(<Composer {...props} sessionId="a" />);
    useVoice.setState({ owner: 'a', phase: 'connecting' });
    view.unmount();
    expect(cancelDictation).toHaveBeenCalled();
    expect(finishDictation).not.toHaveBeenCalled();
  });
  it('leaves another owner’s dictation and a staged send alone', () => {
    const other = render(<Composer {...props} sessionId="a" />);
    useVoice.setState({ owner: 'b', phase: 'recording' });
    other.unmount();
    const staged = render(<Composer {...props} sessionId="a" />);
    useVoice.setState({ owner: 'a', phase: 'finishing', staged: true });
    staged.unmount();
    expect(finishDictation).not.toHaveBeenCalled();
    expect(cancelDictation).not.toHaveBeenCalled();
  });
});
