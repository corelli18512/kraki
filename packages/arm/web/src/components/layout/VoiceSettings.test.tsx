import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VoiceSettings } from './VoiceSettings';
import { useVoice, voiceSettings } from '../../lib/voice/voice';

beforeEach(() => {
  useVoice.setState({ words: [{ term: 'Kraki', heardAs: '' }], serverWords: [{ term: 'Kraki', heardAs: '' }], outbox: [] });
  voiceSettings.correction = true;
});

it('Enter that confirms an IME candidate in a custom word neither saves nor leaves the field', () => {
  render(<VoiceSettings />);
  const word = screen.getByRole('textbox', { name: 'Word or name: Kraki' });
  word.focus();
  fireEvent.compositionStart(word);
  fireEvent.change(word, { target: { value: '克拉' } });
  fireEvent.keyDown(word, { key: 'Enter', isComposing: true });
  fireEvent.keyDown(word, { key: 'Enter', keyCode: 229 });
  expect(word).toHaveFocus();
  expect(useVoice.getState().outbox).toEqual([]);
  fireEvent.compositionEnd(word);
  fireEvent.keyDown(word, { key: 'Enter' });
  expect(word).not.toHaveFocus();
  expect(useVoice.getState().words.map((w) => w.term)).toEqual(['克拉']);
});

it('Enter that confirms an IME candidate in a new word does not add it yet', () => {
  useVoice.setState({ words: [], serverWords: [], outbox: [] });
  render(<VoiceSettings />);
  fireEvent.click(screen.getByRole('button', { name: 'Add Word' }));
  const word = screen.getByRole('textbox', { name: 'Custom word' });
  fireEvent.change(word, { target: { value: '数据库' } });
  fireEvent.keyDown(word, { key: 'Enter', isComposing: true });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Often heard as' }), { key: 'Enter', keyCode: 229 });
  expect(useVoice.getState().words).toEqual([]);
  fireEvent.keyDown(word, { key: 'Enter' });
  expect(useVoice.getState().words.map((w) => w.term)).toEqual(['数据库']);
});

describe('Lower Other Sounds While Recording (Kraki for Windows)', () => {
  afterEach(() => { delete window.krakiDesktop; });
  function bridge(enabled: boolean, ok = true) {
    const voiceVolume = {
      cueStarted: vi.fn(), cueFinished: vi.fn(), captureStarted: vi.fn(), captureStopped: vi.fn(),
      state: vi.fn(async () => ({ enabled })),
      setEnabled: vi.fn(async () => (ok ? { ok: true } : { ok: false, error: 'Could not save.' })),
    };
    window.krakiDesktop = { voiceVolume } as unknown as typeof window.krakiDesktop;
    return voiceVolume;
  }
  it('is absent in the browser and on other desktop systems', () => {
    render(<VoiceSettings />);
    expect(screen.queryByText('Lower Other Sounds While Recording')).toBeNull();
  });
  it('shows the shell setting (on by default) last, with the Mac footer, and saves changes', async () => {
    const voiceVolume = bridge(true);
    render(<VoiceSettings />);
    const toggle = screen.getByRole('switch', { name: 'Lower Other Sounds While Recording' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText(/Turns this PC's sound down while you speak/)).toBeInTheDocument();
    const sections = screen.getByTestId('settings-voice').querySelectorAll('section');
    expect(sections[sections.length - 1]).toContainElement(toggle);
    fireEvent.click(toggle);
    expect(voiceVolume.setEnabled).toHaveBeenCalledWith(false);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
  });
  it('shows a saved off state and reverts when the shell refuses', async () => {
    bridge(false, false);
    render(<VoiceSettings />);
    const toggle = screen.getByRole('switch', { name: 'Lower Other Sounds While Recording' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not save.'));
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
});
