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

  it('limits the name to 64 code points, so emoji count once', () => {
    edit(laptop, '😀'.repeat(70));
    expect(commands.renameDevice).toHaveBeenCalledWith('dev-t', '😀'.repeat(64));
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
