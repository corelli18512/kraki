/**
 * Kraki relays the user's agent as-is: it must not change how pi runs tools.
 * The Kraki permission gate used to inject a default bash `timeout`; a user
 * who wants one configures it in their own pi. Pin that the generated
 * extension source no longer mutates tool input.
 */
import { describe, it, expect } from 'vitest';
import { PI_KRAKI_TOOLS_SOURCE } from '../adapters/pi-kraki-tools.js';

describe('pi permission gate does not alter tool input (source contract)', () => {
  it('does not inject a bash timeout', () => {
    expect(PI_KRAKI_TOOLS_SOURCE).toMatch(/toolName === "bash"/);
    expect(PI_KRAKI_TOOLS_SOURCE).not.toMatch(/input\.timeout\s*=/);
  });

  it('still blocks self-management commands through the shared matcher', () => {
    expect(PI_KRAKI_TOOLS_SOURCE).toMatch(/function krakiIsSelfManagement\(command\)/);
    expect(PI_KRAKI_TOOLS_SOURCE).toMatch(/if \(krakiIsSelfManagement\(command\)\)/);
  });
});
