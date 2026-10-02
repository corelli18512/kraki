import { describe, it, expect } from 'vitest';
import { withHiddenWindow, hideChildWindowsByDefault } from '../windows-hide.js';

describe('windows-hide', () => {
  it('adds windowsHide to every call shape, keeping callbacks and explicit choices', () => {
    const cb = () => {};
    expect(withHiddenWindow('spawn', ['pi', ['--mode', 'rpc'], { cwd: 'C:\\' }])).toEqual(['pi', ['--mode', 'rpc'], { cwd: 'C:\\', windowsHide: true }]);
    expect(withHiddenWindow('spawn', ['pi', ['x']])).toEqual(['pi', ['x'], { windowsHide: true }]);
    expect(withHiddenWindow('spawn', ['pi', { stdio: 'pipe' }])).toEqual(['pi', { stdio: 'pipe', windowsHide: true }]);
    expect(withHiddenWindow('execSync', ['codex --version'])).toEqual(['codex --version', { windowsHide: true }]);
    expect(withHiddenWindow('exec', ['where node', cb])).toEqual(['where node', { windowsHide: true }, cb]);
    expect(withHiddenWindow('execFile', ['reg', ['query'], cb])).toEqual(['reg', ['query'], { windowsHide: true }, cb]);
    expect(withHiddenWindow('spawn', ['x', [], { windowsHide: false }])).toEqual(['x', [], { windowsHide: false }]);
  });

  it('only patches on Windows', () => {
    expect(hideChildWindowsByDefault('darwin')).toBe(false);
  });
});
