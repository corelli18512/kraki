import { describe, it, expect } from 'vitest';
import { loginCommand } from '../windows-autostart.js';

describe('Windows login autostart', () => {
  it('starts the standalone binary quietly and without a console window', () => {
    expect(loginCommand('C:\\Users\\a b\\AppData\\Local\\Kraki\\kraki.exe', undefined, true))
      .toBe('conhost.exe --headless "C:\\Users\\a b\\AppData\\Local\\Kraki\\kraki.exe" start --login');
  });

  it('runs the npm entry point with node', () => {
    expect(loginCommand('C:\\node\\node.exe', 'C:\\npm\\node_modules\\@kraki\\tentacle\\dist\\cli.js', false))
      .toBe('conhost.exe --headless "C:\\node\\node.exe" "C:\\npm\\node_modules\\@kraki\\tentacle\\dist\\cli.js" start --login');
  });
});

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import { defaultDeviceName } from '../setup.js';

describe('kraki logs without tail', () => {
  it('prints the last lines of each log', async () => {
    const { tailLogsPortable } = await import('../cli.js');
    const dir = mkdtempSync(join(tmpdir(), 'kraki-logs-'));
    writeFileSync(join(dir, 'daemon.log'), Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n') + '\n');
    const out: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m) => { out.push(String(m)); });
    tailLogsPortable(dir, false, 3);
    spy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
    expect(out.at(-1)).toBe('line 77\nline 78\nline 79');
  });
});

describe('default device name', () => {
  it("replaces Windows' factory hostname with the user's name", () => {
    expect(defaultDeviceName('DESKTOP-255SCED', 'win32', 'Alice')).toBe("Alice's Windows PC");
    expect(defaultDeviceName('LAPTOP-AB12CD3', 'win32', 'bob')).toBe("bob's Windows PC");
    expect(defaultDeviceName('studio', 'win32', 'Alice')).toBe('studio');
    expect(defaultDeviceName('Mac.local', 'darwin', 'Alice')).toBe('Mac');
  });
});
