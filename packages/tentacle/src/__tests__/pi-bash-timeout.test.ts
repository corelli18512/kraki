/**
 * Regression for the per-turn wedge: a bash command that hangs forever (held
 * handles, deadlocked child) used to block the whole turn until the idle-evicter
 * mis-killed the session, because pi's bash tool ships NO default timeout.
 *
 * The Kraki permission gate now injects a default `timeout` (seconds) when the
 * model didn't set one, so pi kills the process tree and reports the timeout
 * back to the model. This is a compile-time contract test on the generated
 * extension source (the gate runs inside the pi child process as a string, so
 * it can't be imported directly — but its behavior is pinned by the source it
 * must contain).
 */
import { describe, it, expect } from 'vitest';
import { PI_KRAKI_TOOLS_SOURCE } from '../adapters/pi-kraki-tools.js';

describe('pi bash timeout default injection (source contract)', () => {
  it('injects a default timeout for bash when the model did not set one', () => {
    // The gate mutates `input.timeout` for the bash branch. Pinned so the
    // injection isn't accidentally removed.
    expect(PI_KRAKI_TOOLS_SOURCE).toMatch(/toolName === "bash"/);
    expect(PI_KRAKI_TOOLS_SOURCE).toMatch(/input\.timeout === undefined/);
    expect(PI_KRAKI_TOOLS_SOURCE).toMatch(/input\.timeout = \d+/);
  });

  it('uses a sane default (>= 5 min) that won\'t kill long pipelines', () => {
    const m = PI_KRAKI_TOOLS_SOURCE.match(/input\.timeout = (\d+)/);
    expect(m).not.toBeNull();
    const defaultSeconds = Number(m![1]);
    // Long enough for builds/tests/deploys; short enough that a wedged command
    // surfaces (vs hanging until the idle-evicter mis-kills the session).
    expect(defaultSeconds).toBeGreaterThanOrEqual(300);
    expect(defaultSeconds).toBeLessThanOrEqual(1800);
  });

  it('only injects inside the bash branch (not for other tools)', () => {
    // The timeout assignment must be scoped within `if (toolName === "bash")`.
    const bashIdx = PI_KRAKI_TOOLS_SOURCE.indexOf('toolName === "bash"');
    const timeoutIdx = PI_KRAKI_TOOLS_SOURCE.indexOf('input.timeout =');
    expect(bashIdx).toBeGreaterThan(-1);
    expect(timeoutIdx).toBeGreaterThan(bashIdx);
    // And it must come before the generic confirm path (outside the bash branch).
    const confirmIdx = PI_KRAKI_TOOLS_SOURCE.indexOf('ctx.ui.confirm');
    expect(timeoutIdx).toBeLessThan(confirmIdx);
  });
});
