import { afterEach, describe, expect, it } from 'vitest';
import { allowAutoRead, isAutoReadSuppressed, suppressAutoRead } from './read-visibility';

const SESSION_ID = 'session-manual-unread';

afterEach(() => allowAutoRead(SESSION_ID));

describe('read visibility guard', () => {
  it('holds manual unread until the view explicitly allows auto-read again', () => {
    expect(isAutoReadSuppressed(SESSION_ID)).toBe(false);
    suppressAutoRead(SESSION_ID);
    expect(isAutoReadSuppressed(SESSION_ID)).toBe(true);
    allowAutoRead(SESSION_ID);
    expect(isAutoReadSuppressed(SESSION_ID)).toBe(false);
  });
});
