import 'fake-indexeddb/auto';
import type { ContentRef } from '@kraki/protocol';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetForTests, failAttachment } from '../lib/attachments';
import { useAttachment } from './useAttachment';

const REF: ContentRef = {
  type: 'content_ref',
  id: '00000000000000000000000000000000',
  mimeType: 'image/png',
  size: 8,
};

describe('useAttachment pull ownership', () => {
  beforeEach(() => {
    __resetForTests();
  });

  it('allows only one pull when duplicate mounts share the same IDB miss', async () => {
    const requestPull = vi.fn();
    const first = renderHook(() => useAttachment(REF, 'session-1', requestPull));
    const second = renderHook(() => useAttachment(REF, 'session-1', requestPull));

    await waitFor(() => expect(requestPull).toHaveBeenCalledTimes(1));
    expect(requestPull).toHaveBeenCalledWith('session-1', REF);

    first.unmount();
    second.unmount();
  });
  it('retries a failed pull and suppresses duplicate retries while fetching', async () => {
    const requestPull = vi.fn();
    const hook = renderHook(() => useAttachment(REF, 'session-1', requestPull));
    await waitFor(() => expect(requestPull).toHaveBeenCalledTimes(1));
    act(() => failAttachment(REF, 'Offline'));
    expect(hook.result.current.status).toBe('error');
    act(() => { hook.result.current.retry(); hook.result.current.retry(); });
    expect(requestPull).toHaveBeenCalledTimes(2);
    expect(hook.result.current.status).toBe('loading');
  });

});
