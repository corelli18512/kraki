import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReasoningEffort } from '@kraki/protocol';
import { i18next } from '../../i18n';
import { NewSessionDialog } from './NewSessionDialog';
import { NewSessionComposer } from './NewSessionComposer';
import { useStore } from '../../hooks/useStore';

vi.mock('../chat/Voice', () => ({
  MicButton: () => null, VoiceError: () => null, VoiceRow: () => null, VoiceTranscript: () => null,
  useDictation: () => ({ active: false }), useStartDictation: () => vi.fn(),
}));

beforeEach(() => { useStore.getState().reset(); localStorage.clear(); });

afterEach(async () => { await i18next.changeLanguage('en'); });

describe('NewSessionComposer', () => {
  it('shows raw unknown reasoning efforts instead of translation keys in both pickers', async () => {
    const unknownEffort = 'future-effort' as ReasoningEffort;
    useStore.getState().setDevices([{ id: 'computer', name: 'Office PC', role: 'tentacle', online: true }]);
    useStore.getState().setDeviceAgents('computer', [{
      type: 'code', id: 'copilot', models: ['model'], modelDetails: [{
        id: 'model', name: 'Model', supportsReasoningEffort: true,
        supportedReasoningEfforts: [unknownEffort], defaultReasoningEffort: unknownEffort,
      }],
    }]);
    const composer = render(<NewSessionComposer />);
    expect(screen.getByTestId('new-session-effort')).toHaveTextContent('future-effort');
    fireEvent.click(screen.getByTestId('new-session-effort'));
    expect(screen.getByRole('option')).toHaveTextContent('future-effortfuture-effort');
    await act(async () => { await i18next.changeLanguage('zh-Hans'); });
    expect(screen.getByTestId('new-session-effort')).toHaveTextContent('future-effort');
    expect(screen.getByRole('option')).toHaveTextContent('future-effortfuture-effort');
    composer.unmount();
    const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    try {
      render(<NewSessionDialog open onClose={() => {}} />);
      expect(screen.getByRole('button', { name: 'future-effort' })).toBeInTheDocument();
    } finally {
      if (scrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoView);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it.each([
    ['connecting', 'Connecting to the computer…', '正在连接电脑…'],
    ['noAgents', 'No coding agent on this computer', '这台电脑上没有编程 Agent'],
  ])('uses a full sentence for an unnamed %s computer', async (availability, english, chinese) => {
    // A newly discovered computer may not have supplied its name yet.
    useStore.getState().setDevices([{ id: 'unnamed', name: undefined as unknown as string, role: 'tentacle', online: true }]);
    if (availability === 'noAgents') useStore.getState().setDeviceAgents('unnamed', []);
    render(<NewSessionComposer />);
    expect(screen.getByText(english)).toBeInTheDocument();
    await act(async () => { await i18next.changeLanguage('zh-Hans'); });
    expect(screen.getByText(chinese)).toBeInTheDocument();
  });

  it('keeps a named computer in localized status sentences', async () => {
    useStore.getState().setDevices([{ id: 'computer', name: 'Office PC', role: 'tentacle', online: true }]);
    render(<NewSessionComposer />);
    expect(screen.getByText('Connecting to Office PC…')).toBeInTheDocument();
    await act(async () => { await i18next.changeLanguage('zh-Hans'); });
    expect(screen.getByText('正在连接 Office PC…')).toBeInTheDocument();
    act(() => { useStore.getState().setDeviceAgents('computer', []); });
    expect(screen.getByText('Office PC 上没有编程 Agent')).toBeInTheDocument();
  });

  it('updates its default placeholder and empty state when the language changes', async () => {
    render(<NewSessionComposer />);
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Describe a task, e.g. “Fix the failing tests in my-app”');
    await act(async () => { await i18next.changeLanguage('zh-Hans'); });
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', '描述任务，例如“修复 my-app 中失败的测试”');
    expect(screen.getByTestId('new-session-device')).toHaveTextContent('选择电脑');
    expect(screen.getByRole('button', { name: '开始会话' })).toHaveAttribute('title', '开始会话 (Enter)');
    expect(screen.getByText('没有在线电脑。在电脑上打开 Kraki，即可在该电脑上开始会话。')).toBeInTheDocument();
  });

  it('preserves a caller-provided placeholder in every language', async () => {
    await i18next.changeLanguage('zh-Hans');
    render(<NewSessionComposer placeholder="User-provided instruction" />);
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'User-provided instruction');
  });
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
    const unavailable = screen.getByRole('option', { name: 'Offline computer Open Kraki on it to use it' });
    expect(unavailable).toBeDisabled();
    fireEvent.click(unavailable);
    expect(screen.getByTestId('new-session-device')).toHaveTextContent('Online computer');
    expect(screen.getByRole('option', { name: 'Online computer' }).querySelector('svg rect')).toHaveAttribute('fill-opacity', '0.25');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
