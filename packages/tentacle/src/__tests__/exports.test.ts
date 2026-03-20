/**
 * Verify the package's public API exports work correctly.
 */

import { describe, it, expect } from 'vitest';
import { CopilotAdapter, AgentAdapter, parsePermission } from '../index.js';

describe('kraki exports', () => {
  it('exports CopilotAdapter', () => {
    expect(CopilotAdapter).toBeDefined();
    expect(typeof CopilotAdapter).toBe('function');
  });

  it('exports AgentAdapter', () => {
    expect(AgentAdapter).toBeDefined();
    expect(typeof AgentAdapter).toBe('function');
  });

  it('CopilotAdapter extends AgentAdapter', () => {
    const adapter = new CopilotAdapter();
    expect(adapter).toBeInstanceOf(AgentAdapter);
  });

  it('exports parsePermission', () => {
    expect(parsePermission).toBeDefined();
    expect(typeof parsePermission).toBe('function');
  });
});
