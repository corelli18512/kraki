import { beforeEach, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
