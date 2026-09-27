import { describe, it, expect } from 'vitest';
import { selectCliPath } from '../adapters/multi.js';

describe('selectCliPath', () => {
  it('skips the npm POSIX shim before the Windows cmd shim', () => {
    expect(selectCliPath('C:\\nvm4w\\nodejs\\codex\r\nC:\\nvm4w\\nodejs\\codex.cmd\r\n', 'win32'))
      .toBe('C:\\nvm4w\\nodejs\\codex.cmd');
  });
  it('preserves PATH precedence between executable Windows candidates', () => {
    expect(selectCliPath('C:\\First Folder\\codex.exe\r\nC:\\second\\codex.cmd', 'win32'))
      .toBe('C:\\First Folder\\codex.exe');
  });
  it('does not launch an unsupported POSIX or PowerShell script', () => {
    expect(selectCliPath('C:\\nodejs\\codex\r\nC:\\nodejs\\codex.ps1', 'win32')).toBeUndefined();
  });
  it('keeps extensionless Unix executables', () => {
    expect(selectCliPath('/usr/local/bin/codex\n/usr/bin/codex\n', 'darwin')).toBe('/usr/local/bin/codex');
    expect(selectCliPath('', 'linux')).toBeUndefined();
  });
});
