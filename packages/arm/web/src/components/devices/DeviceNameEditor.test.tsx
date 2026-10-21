import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { DeviceSummary } from '@kraki/protocol';
import { DeviceNameEditor } from './DeviceNameEditor';

const commands = vi.hoisted(() => ({ renameDevice: vi.fn() }));
vi.mock('../../lib/ws-client', () => ({ wsClient: commands }));

const laptop: DeviceSummary = { id: 'dev-t', name: 'corelli-mbp', role: 'tentacle', online: false };
const renamed: DeviceSummary = { ...laptop, name: 'Work laptop', defaultName: 'corelli-mbp' };

function edit(device: DeviceSummary, value: string, key = 'Enter') {
  render(<DeviceNameEditor device={device} />);
  fireEvent.click(screen.getByRole('button', { name: `Rename ${device.name}` }));
  const input = screen.getByRole('textbox', { name: 'Device name' });
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key });
}

describe('DeviceNameEditor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the normalised name, also for an offline device', () => {
    edit(laptop, '  Work \n laptop ');
    expect(commands.renameDevice).toHaveBeenCalledWith('dev-t', 'Work laptop');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('clears the custom name when emptied or set back to the device\'s own name', () => {
    edit(renamed, '   ');
    expect(commands.renameDevice).toHaveBeenLastCalledWith('dev-t', '');
    document.body.innerHTML = '';
    edit(renamed, 'corelli-mbp');
    expect(commands.renameDevice).toHaveBeenLastCalledWith('dev-t', '');
  });

  it('limits the name to 64 code points (emoji count once) and refuses edits that would go over', () => {
    edit(laptop, '😀'.repeat(64));
    expect(commands.renameDevice).toHaveBeenLastCalledWith('dev-t', '😀'.repeat(64));

    document.body.innerHTML = '';
    const full = { ...laptop, name: 'x'.repeat(64), defaultName: 'corelli-mbp' };
    render(<DeviceNameEditor device={full} />);
    fireEvent.click(screen.getByRole('button', { name: `Rename ${full.name}` }));
    const input = screen.getByRole('textbox', { name: 'Device name' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: `A${full.name}` } }); // insert at the start
    expect(input.value).toBe(full.name); // refused: nothing at the end was dropped
  });

  it('never cuts an IME composition; an over-long result goes back to the text before it', () => {
    const full = { ...laptop, name: 'x'.repeat(63), defaultName: 'corelli-mbp' };
    render(<DeviceNameEditor device={full} />);
    fireEvent.click(screen.getByRole('button', { name: `Rename ${full.name}` }));
    const input = screen.getByRole('textbox', { name: 'Device name' }) as HTMLInputElement;
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: `${full.name}ni` } }); // pinyin in progress, over the limit
    expect(input.value).toBe(`${full.name}ni`);
    fireEvent.change(input, { target: { value: `${full.name}你` } });
    fireEvent.compositionEnd(input);
    expect(input.value).toBe(`${full.name}你`); // 64: fits
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: `${full.name}你好` } });
    fireEvent.compositionEnd(input);
    expect(input.value).toBe(`${full.name}你`); // 65: back to before this composition
  });

  it('sends nothing when the name did not change or on Escape', () => {
    edit(renamed, 'Work laptop');
    document.body.innerHTML = '';
    edit(laptop, '');
    document.body.innerHTML = '';
    edit(laptop, 'Something else', 'Escape');
    expect(commands.renameDevice).not.toHaveBeenCalled();
  });
});

it('Enter or Escape that confirms an IME candidate neither saves nor closes', () => {
  commands.renameDevice.mockClear();
  render(<DeviceNameEditor device={laptop} />);
  fireEvent.click(screen.getByRole('button', { name: `Rename ${laptop.name}` }));
  const input = screen.getByRole('textbox', { name: 'Device name' });
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: '书房' } });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  fireEvent.keyDown(input, { key: 'Escape', keyCode: 229 });
  expect(commands.renameDevice).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Device name' })).toBe(input);
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(commands.renameDevice).toHaveBeenCalledWith(laptop.id, '书房');
});
