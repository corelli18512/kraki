import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NewSessionComposer } from './NewSessionComposer';
import { useStore } from '../../hooks/useStore';

vi.mock('../chat/Voice', () => ({
  MicButton: () => null, VoiceError: () => null, VoiceRow: () => null, VoiceTranscript: () => null,
  useDictation: () => ({ active: false }), useStartDictation: () => vi.fn(),
}));

beforeEach(() => { useStore.getState().reset(); localStorage.clear(); });

describe('NewSessionComposer', () => {
  it('keeps the new-session draft across visiting a session', () => {
    const first = render(<NewSessionComposer />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unfinished task' } });
    first.unmount();
    render(<NewSessionComposer />);
    expect(screen.getByRole('textbox')).toHaveValue('unfinished task');
  });

  it('fits three through ten 18px lines plus the native editor inset', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this instanceof HTMLTextAreaElement ? this.value.split('\n').length * 18 + 2 : 0;
    });
    try {
      render(<NewSessionComposer />);
      const editor = screen.getByRole('textbox');
      expect(editor.style.height).toBe('56px');
      fireEvent.change(editor, { target: { value: 'one\ntwo\nthree\nfour' } });
      expect(editor.style.height).toBe('74px');
      fireEvent.change(editor, { target: { value: Array(12).fill('line').join('\n') } });
      expect(editor.style.height).toBe('182px');
      fireEvent.change(editor, { target: { value: '' } });
      expect(editor.style.height).toBe('56px');
    } finally { height.mockRestore(); }
  });

  it('shows device sections above the choices and closes its popover on Escape', () => {
    useStore.getState().setDevices([
      { id: 'online', name: 'Online computer', role: 'tentacle', online: true },
      { id: 'offline', name: 'Offline computer', role: 'tentacle', online: false },
    ]);
    render(<NewSessionComposer />);
    fireEvent.click(screen.getByTestId('new-session-device'));
    expect(screen.getByRole('listbox')).toHaveTextContent('Online');
    expect(screen.getByRole('option', { name: 'Offline computer Open Kraki on it to use it' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
