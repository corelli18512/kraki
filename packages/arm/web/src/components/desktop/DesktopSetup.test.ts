import { describe, expect, it } from 'vitest';
import { setupStep } from './DesktopSetup';
import type { BuiltInState } from '../../lib/desktop';

const base: BuiltInState = {
  available: true, version: '0.35.12', configured: false, signedIn: false, deviceName: 'PC', deviceId: null, relay: null,
  owned: false, running: false, relayState: null, cliDaemon: false, cliLogin: false,
};
const s = (over: Partial<BuiltInState>) => ({ ...base, ...over });

describe('Kraki for Windows setup steps (BuiltInSetupView.step)', () => {
  it('detects first', () => {
    expect(setupStep(null, 'undecided', 'undecided', false, false)).toBe('detecting');
  });
  it('new user: this PC, then sign in, then background, then done', () => {
    expect(setupStep(s({}), 'undecided', 'undecided', false, false)).toBe('thisPC');
    expect(setupStep(s({}), 'runsAgents', 'undecided', false, false)).toBe('signIn');
    expect(setupStep(s({ configured: true }), 'runsAgents', 'undecided', false, false)).toBe('background');
    expect(setupStep(s({ configured: true, owned: true, running: true }), 'runsAgents', 'undecided', false, false)).toBe('done');
  });
  it('remote-only still signs in but never runs the daemon', () => {
    expect(setupStep(s({}), 'remoteOnly', 'undecided', false, false)).toBe('signIn');
    expect(setupStep(s({ configured: true }), 'remoteOnly', 'undecided', false, false)).toBe('done');
  });
  it('a command-line Kraki already set up here asks which one runs', () => {
    expect(setupStep(s({ configured: true, cliDaemon: true, running: true }), 'undecided', 'undecided', false, false)).toBe('chooseOwner');
    expect(setupStep(s({ configured: true, cliLogin: true }), 'undecided', 'undecided', false, false)).toBe('chooseOwner');
    expect(setupStep(s({ configured: true, cliDaemon: true, running: true }), 'undecided', 'external', false, false)).toBe('done');
    // Moved over from the CLI: agents check, but no new sign-in.
    expect(setupStep(s({ configured: true, owned: true, running: true }), 'undecided', 'builtIn', true, false)).toBe('thisPC');
    expect(setupStep(s({ configured: true, owned: true, running: true }), 'runsAgents', 'builtIn', false, false)).toBe('done');
  });
  it('an existing config without a CLI login entry or daemon is not a choice', () => {
    expect(setupStep(s({ configured: true }), 'undecided', 'undecided', false, false)).toBe('background');
  });
  it('a refused sign-in asks to sign in again', () => {
    expect(setupStep(s({ configured: true, owned: true, running: true }), 'runsAgents', 'undecided', false, true)).toBe('signIn');
    expect(setupStep(s({ configured: true }), 'undecided', 'external', false, true)).toBe('signIn');
  });
});
