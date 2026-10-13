import { describe, it, expect } from 'vitest';
import { agentEnv } from '../agent-env.js';

describe('agentEnv', () => {
  it('drops the daemon-only variables and keeps the user environment', () => {
    const env = agentEnv({}, {
      NODE_ENV: 'production', LOG_LEVEL: 'info', KRAKI_SUPERVISED: '42', KRAKI_MANAGED_BY: 'kraki-mac',
      KRAKI_META_FILE: '/x', KRAKI_HOME: '/h/.kraki', PATH: '/usr/bin', ANTHROPIC_API_KEY: 'k',
    });
    expect(env).toEqual({ KRAKI_HOME: '/h/.kraki', PATH: '/usr/bin', ANTHROPIC_API_KEY: 'k' });
  });

  it('applies extra variables last', () => {
    expect(agentEnv({ KRAKI_META_FILE: '/meta.json' }, { KRAKI_META_FILE: '/old' }).KRAKI_META_FILE).toBe('/meta.json');
  });
});
